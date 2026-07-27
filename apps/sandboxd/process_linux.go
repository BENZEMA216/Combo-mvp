//go:build linux

package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

var (
	errProcessUnsupported = errors.New("sandbox process control requires Linux")
	errProcessCleanup     = errors.New("sandbox descendant cleanup failed")
)

type runningCommand struct {
	id              string
	started         chan struct{}
	executionDone   chan struct{}
	done            chan struct{}
	terminate       sync.Once
	terminationWait sync.WaitGroup
	cancelledMu     sync.Mutex
	cancelled       bool
	resultMu        sync.Mutex
	result          error
	cmd             *exec.Cmd
	baseline        map[int]uint64
}

func (running *runningCommand) markCancelled() {
	running.cancelledMu.Lock()
	running.cancelled = true
	running.cancelledMu.Unlock()
}

func (running *runningCommand) wasCancelled() bool {
	running.cancelledMu.Lock()
	defer running.cancelledMu.Unlock()
	return running.cancelled
}

type commandManager struct {
	mu               sync.Mutex
	active           *runningCommand
	workspace        string
	commandWrapper   string
	defaultTimeout   time.Duration
	maximumTimeout   time.Duration
	maxOutputBytes   int64
	maxOutputFrames  int
	outputChunkBytes int
	terminationGrace time.Duration
}

func newCommandManager(config Config) (*commandManager, error) {
	if config.CommandWrapper != "" {
		info, err := os.Stat(config.CommandWrapper)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			return nil, errors.New("sandbox command wrapper is unavailable")
		}
	}
	if err := unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0); err != nil {
		return nil, fmt.Errorf("enable child subreaper: %w", err)
	}
	// Commands run under the same non-root UID as sandboxd. Mark the daemon
	// non-dumpable so a child cannot open /proc/<sandboxd>/fd/1 and bypass the
	// bounded command stream by writing workspace content directly to Pod logs.
	if err := unix.Prctl(unix.PR_SET_DUMPABLE, 0, 0, 0, 0); err != nil {
		return nil, fmt.Errorf("disable process inspection: %w", err)
	}
	chunkBytes, err := outputChunkSize(config.MaxFrameBytes)
	if err != nil {
		return nil, err
	}
	return &commandManager{
		workspace:        config.Workspace,
		commandWrapper:   config.CommandWrapper,
		defaultTimeout:   config.CommandTimeout,
		maximumTimeout:   config.MaxCommandTime,
		maxOutputBytes:   config.MaxOutputBytes,
		maxOutputFrames:  config.MaxOutputFrames,
		outputChunkBytes: chunkBytes,
		terminationGrace: time.Second,
	}, nil
}

func (manager *commandManager) begin(request commandRequest) (*runningCommand, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.active != nil {
		return nil, errCommandBusy
	}
	running := &runningCommand{
		id:            request.CommandID,
		started:       make(chan struct{}),
		executionDone: make(chan struct{}),
		done:          make(chan struct{}),
		baseline:      snapshotProcesses(),
	}
	manager.active = running
	return running, nil
}

func (manager *commandManager) finish(running *runningCommand, result error) {
	// Keep the slot occupied until both the command and the asynchronous signal
	// sender have stopped. A successful cancel response therefore proves that no
	// process from this command can leak into the next Turn.
	manager.mu.Lock()
	defer manager.mu.Unlock()
	close(running.executionDone)
	running.terminationWait.Wait()
	running.resultMu.Lock()
	running.result = result
	running.resultMu.Unlock()
	if manager.active == running {
		manager.active = nil
	}
	close(running.done)
}

func (manager *commandManager) cancel(ctx context.Context, commandID string) (bool, error) {
	manager.mu.Lock()
	running := manager.active
	if running == nil || running.id != commandID {
		manager.mu.Unlock()
		return false, nil
	}
	running.markCancelled()
	manager.terminate(running)
	manager.mu.Unlock()

	select {
	case <-running.done:
		running.resultMu.Lock()
		result := running.result
		running.resultMu.Unlock()
		if errors.Is(result, errProcessCleanup) {
			return true, errProcessCleanup
		}
		return true, nil
	case <-ctx.Done():
		return true, ctx.Err()
	}
}

func (manager *commandManager) close() {
	manager.mu.Lock()
	running := manager.active
	manager.mu.Unlock()
	if running == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _ = manager.cancel(ctx, running.id)
}

func (manager *commandManager) terminate(running *runningCommand) {
	running.terminate.Do(func() {
		running.terminationWait.Add(1)
		go func() {
			defer running.terminationWait.Done()
			select {
			case <-running.started:
			case <-running.executionDone:
				return
			}
			if running.cmd != nil && running.cmd.Process != nil {
				_ = unix.Kill(-running.cmd.Process.Pid, unix.SIGTERM)
			}
			killNewProcesses(running.baseline, unix.SIGTERM)
			timer := time.NewTimer(manager.terminationGrace)
			defer timer.Stop()
			select {
			case <-timer.C:
			case <-running.executionDone:
				// run performs the final repeated descendant sweep before announcing completion.
				return
			}
			if running.cmd != nil && running.cmd.Process != nil {
				_ = unix.Kill(-running.cmd.Process.Pid, unix.SIGKILL)
			}
			killNewProcesses(running.baseline, unix.SIGKILL)
		}()
	})
}

type outputBudget struct {
	mu              sync.Mutex
	remainingBytes  int64
	remainingFrames int
	exceeded        bool
}

func (budget *outputBudget) take(size int) bool {
	budget.mu.Lock()
	defer budget.mu.Unlock()
	if budget.exceeded || int64(size) > budget.remainingBytes || budget.remainingFrames <= 0 {
		budget.exceeded = true
		return false
	}
	budget.remainingBytes -= int64(size)
	budget.remainingFrames--
	return true
}

func (budget *outputBudget) wasExceeded() bool {
	budget.mu.Lock()
	defer budget.mu.Unlock()
	return budget.exceeded
}

func (manager *commandManager) pump(
	running *runningCommand,
	reader io.Reader,
	streamName string,
	budget *outputBudget,
	emit func(commandFrame) error,
	disconnected *bool,
	disconnectMu *sync.Mutex,
) {
	buffer := make([]byte, manager.outputChunkBytes)
	for {
		read, err := reader.Read(buffer)
		if read > 0 {
			if !budget.take(read) {
				manager.terminate(running)
				return
			}
			if emit(commandFrame{
				Type:      "output",
				CommandID: running.id,
				Stream:    streamName,
				Encoding:  "base64",
				Data:      base64.StdEncoding.EncodeToString(buffer[:read]),
			}) != nil {
				disconnectMu.Lock()
				*disconnected = true
				disconnectMu.Unlock()
				manager.terminate(running)
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (manager *commandManager) run(
	ctx context.Context,
	request commandRequest,
	emit func(commandFrame) error,
) (runErr error) {
	running, err := manager.begin(request)
	if err != nil {
		return err
	}
	defer func() { manager.finish(running, runErr) }()

	timeout := manager.defaultTimeout
	if request.TimeoutMS > 0 {
		timeout = time.Duration(request.TimeoutMS) * time.Millisecond
	}
	if timeout <= 0 || timeout > manager.maximumTimeout {
		return errors.New("invalid command timeout")
	}
	startedAt := time.Now()
	commandContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var cmd *exec.Cmd
	if manager.commandWrapper != "" {
		cmd = exec.Command(manager.commandWrapper, manager.workspace, request.Command)
	} else {
		// Unit tests exercise process cleanup without relying on an installed image.
		// Production loadConfig always supplies the fail-closed Landlock wrapper.
		cmd = exec.Command("/bin/bash", "--noprofile", "--norc", "-lc", request.Command)
	}
	cmd.Dir = manager.workspace
	cmd.Env = []string{
		"HOME=" + manager.workspace,
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"TMPDIR=/tmp",
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	// Use caller-owned pipes instead of Cmd.StdoutPipe/StderrPipe. Cmd.Wait closes
	// its managed pipes as soon as the direct shell exits and can race the pump,
	// dropping the final output bytes. These readers remain valid through the
	// descendant sweep and are closed explicitly below.
	stdout, stdoutWriter, err := os.Pipe()
	if err != nil {
		return errors.New("command setup failed")
	}
	stderr, stderrWriter, err := os.Pipe()
	if err != nil {
		_ = stdout.Close()
		_ = stdoutWriter.Close()
		return errors.New("command setup failed")
	}
	cmd.Stdout = stdoutWriter
	cmd.Stderr = stderrWriter
	running.cmd = cmd
	if err := cmd.Start(); err != nil {
		_ = stdout.Close()
		_ = stdoutWriter.Close()
		_ = stderr.Close()
		_ = stderrWriter.Close()
		close(running.started)
		return errors.New("command start failed")
	}
	_ = stdoutWriter.Close()
	_ = stderrWriter.Close()
	close(running.started)
	if err := emit(commandFrame{Type: "start", CommandID: request.CommandID}); err != nil {
		manager.terminate(running)
		_ = cmd.Wait()
		cleaned := cleanupNewProcesses(running.baseline, manager.terminationGrace)
		_ = stdout.Close()
		_ = stderr.Close()
		if !cleaned {
			return errProcessCleanup
		}
		return errors.New("command stream disconnected")
	}

	contextWatcherDone := make(chan struct{})
	go func() {
		defer close(contextWatcherDone)
		<-commandContext.Done()
		if !errors.Is(commandContext.Err(), context.Canceled) || ctx.Err() != nil {
			manager.terminate(running)
		}
	}()

	budget := &outputBudget{
		remainingBytes:  manager.maxOutputBytes,
		remainingFrames: manager.maxOutputFrames,
	}
	var pumps sync.WaitGroup
	var disconnected bool
	var disconnectMu sync.Mutex
	pumps.Add(2)
	go func() {
		defer pumps.Done()
		manager.pump(running, stdout, "stdout", budget, emit, &disconnected, &disconnectMu)
	}()
	go func() {
		defer pumps.Done()
		manager.pump(running, stderr, "stderr", budget, emit, &disconnected, &disconnectMu)
	}()

	waitErr := cmd.Wait()
	cancel()
	<-contextWatcherDone
	// A shell can exit while detached descendants keep work alive. Repeatedly scan
	// the Pod PID namespace so a process cannot survive by forking between two
	// one-shot snapshots. Failure is surfaced as a protocol error; Runtime then
	// conditionally deletes this exact Pod UID.
	cleaned := cleanupNewProcesses(running.baseline, manager.terminationGrace)
	if !cleaned {
		_ = stdout.Close()
		_ = stderr.Close()
	}
	pumps.Wait()
	_ = stdout.Close()
	_ = stderr.Close()
	if !cleaned {
		return errProcessCleanup
	}

	exitCode := 0
	signalName := ""
	if waitErr != nil {
		if exitError, ok := waitErr.(*exec.ExitError); ok {
			exitCode = exitError.ExitCode()
			if status, ok := exitError.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				signalName = status.Signal().String()
			}
		} else {
			exitCode = -1
		}
	}
	disconnectMu.Lock()
	streamDisconnected := disconnected
	disconnectMu.Unlock()
	if streamDisconnected {
		return errors.New("command stream disconnected")
	}
	timedOut := errors.Is(commandContext.Err(), context.DeadlineExceeded)
	cancelled := running.wasCancelled() || (ctx.Err() != nil && !timedOut)
	truncated := budget.wasExceeded()
	if truncated && exitCode == 0 {
		exitCode = 137
	}
	frame := commandFrame{
		Type:       "exit",
		CommandID:  request.CommandID,
		ExitCode:   &exitCode,
		Signal:     signalName,
		TimedOut:   timedOut,
		Cancelled:  cancelled,
		Truncated:  truncated,
		DurationMS: time.Since(startedAt).Milliseconds(),
	}
	if truncated {
		frame.Error = "output_limit_exceeded"
	} else if timedOut {
		frame.Error = "timeout"
	} else if cancelled {
		frame.Error = "cancelled"
	}
	return emit(frame)
}

func processStartTime(pid int) (uint64, bool) {
	file, err := os.Open(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, false
	}
	defer file.Close()
	line, err := bufio.NewReader(file).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return 0, false
	}
	closeParen := strings.LastIndex(line, ")")
	if closeParen < 0 || closeParen+2 >= len(line) {
		return 0, false
	}
	fields := strings.Fields(line[closeParen+2:])
	// /proc/<pid>/stat field 22 is starttime; fields starts at field 3 after stripping pid and comm.
	if len(fields) <= 19 {
		return 0, false
	}
	value, err := strconv.ParseUint(fields[19], 10, 64)
	return value, err == nil
}

func snapshotProcesses() map[int]uint64 {
	entries, _ := os.ReadDir("/proc")
	out := make(map[int]uint64)
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		if start, ok := processStartTime(pid); ok {
			out[pid] = start
		}
	}
	return out
}

func newProcesses(baseline map[int]uint64) []int {
	current := snapshotProcesses()
	self := os.Getpid()
	result := make([]int, 0)
	for pid, start := range current {
		if pid == self {
			continue
		}
		if previous, existed := baseline[pid]; !existed || previous != start {
			result = append(result, pid)
		}
	}
	return result
}

func killNewProcesses(baseline map[int]uint64, signal unix.Signal) {
	for _, pid := range newProcesses(baseline) {
		_ = unix.Kill(pid, signal)
	}
}

func reapProcesses(processes []int) {
	for _, pid := range processes {
		var status unix.WaitStatus
		_, _ = unix.Wait4(pid, &status, unix.WNOHANG, nil)
	}
}

func cleanupNewProcesses(baseline map[int]uint64, grace time.Duration) bool {
	// One empty /proc snapshot is not enough: a daemonizing child can be between
	// clone and visibility while its parent exits. Require a short quiescent
	// interval before accepting cleanup, and reset it whenever a new PID appears.
	const scanInterval = 5 * time.Millisecond
	const quiescence = 25 * time.Millisecond
	waitPhase := func(signal unix.Signal, deadline time.Time) bool {
		var quietSince time.Time
		for time.Now().Before(deadline) {
			remaining := newProcesses(baseline)
			if len(remaining) == 0 {
				if quietSince.IsZero() {
					quietSince = time.Now()
				} else if time.Since(quietSince) >= quiescence {
					return true
				}
			} else {
				quietSince = time.Time{}
				for _, pid := range remaining {
					_ = unix.Kill(pid, signal)
				}
				reapProcesses(remaining)
			}
			time.Sleep(scanInterval)
		}
		return false
	}

	if waitPhase(unix.SIGTERM, time.Now().Add(grace)) {
		return true
	}
	return waitPhase(unix.SIGKILL, time.Now().Add(500*time.Millisecond))
}

func boundedRlimit(current unix.Rlimit, maximum uint64) unix.Rlimit {
	if current.Max < maximum {
		maximum = current.Max
	}
	return unix.Rlimit{Cur: maximum, Max: maximum}
}

func applyProcessLimits() error {
	limits := []struct {
		resource int
		value    uint64
	}{
		{resource: unix.RLIMIT_NOFILE, value: 128},
		{resource: unix.RLIMIT_NPROC, value: 256},
	}
	for _, limit := range limits {
		current := &unix.Rlimit{}
		if err := unix.Getrlimit(limit.resource, current); err != nil {
			return err
		}
		bounded := boundedRlimit(*current, limit.value)
		if err := unix.Setrlimit(limit.resource, &bounded); err != nil {
			return err
		}
	}
	return nil
}
