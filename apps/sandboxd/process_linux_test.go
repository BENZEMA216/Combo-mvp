//go:build linux

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func processManagerForTest(t *testing.T, maximumOutput int64) *commandManager {
	t.Helper()
	manager, err := newCommandManager(Config{
		Workspace:       t.TempDir(),
		CommandTimeout:  2 * time.Second,
		MaxCommandTime:  3 * time.Second,
		MaxOutputBytes:  maximumOutput,
		MaxOutputFrames: defaultMaxOutputFrames,
		MaxFrameBytes:   defaultMaxFrameBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.close)
	manager.terminationGrace = 25 * time.Millisecond
	return manager
}

func collectCommandFrames(
	manager *commandManager,
	request commandRequest,
) ([]commandFrame, error) {
	var mu sync.Mutex
	frames := make([]commandFrame, 0)
	err := manager.run(context.Background(), request, func(frame commandFrame) error {
		mu.Lock()
		frames = append(frames, frame)
		mu.Unlock()
		return nil
	})
	mu.Lock()
	defer mu.Unlock()
	return append([]commandFrame(nil), frames...), err
}

func decodedFrameData(t *testing.T, frame commandFrame) string {
	t.Helper()
	if frame.Encoding != "base64" {
		t.Fatalf("output frame encoding = %q", frame.Encoding)
	}
	decoded, err := base64.StdEncoding.DecodeString(frame.Data)
	if err != nil {
		t.Fatalf("invalid output base64: %v", err)
	}
	return string(decoded)
}

func terminalFrame(frames []commandFrame) *commandFrame {
	for index := len(frames) - 1; index >= 0; index-- {
		if frames[index].Type == "exit" {
			return &frames[index]
		}
	}
	return nil
}

func TestCommandStreamsOneProtocolAndExit(t *testing.T) {
	manager := processManagerForTest(t, 1024)
	frames, err := collectCommandFrames(manager, commandRequest{
		CommandID: "command-1",
		Command:   "printf out; printf err >&2; exit 7",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) < 4 || frames[0].Type != "start" {
		t.Fatalf("unexpected frames: %#v", frames)
	}
	var stdout, stderr string
	for _, frame := range frames {
		if frame.Type == "output" && frame.Stream == "stdout" {
			stdout += decodedFrameData(t, frame)
		}
		if frame.Type == "output" && frame.Stream == "stderr" {
			stderr += decodedFrameData(t, frame)
		}
	}
	terminal := terminalFrame(frames)
	if stdout != "out" || stderr != "err" || terminal == nil || terminal.ExitCode == nil || *terminal.ExitCode != 7 {
		t.Fatalf("unexpected output/terminal: stdout=%q stderr=%q terminal=%#v", stdout, stderr, terminal)
	}
}

func TestCommandTimeoutAndOutputLimitTerminateProcess(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		manager := processManagerForTest(t, 1024)
		frames, err := collectCommandFrames(manager, commandRequest{
			CommandID: "timeout-1",
			Command:   "sleep 30",
			TimeoutMS: 40,
		})
		if err != nil {
			t.Fatal(err)
		}
		terminal := terminalFrame(frames)
		if terminal == nil || !terminal.TimedOut || terminal.Error != "timeout" {
			t.Fatalf("unexpected timeout terminal: %#v", terminal)
		}
	})

	t.Run("output", func(t *testing.T) {
		manager := processManagerForTest(t, 64)
		frames, err := collectCommandFrames(manager, commandRequest{
			CommandID: "output-1",
			Command:   "yes x",
		})
		if err != nil {
			t.Fatal(err)
		}
		terminal := terminalFrame(frames)
		if terminal == nil || !terminal.Truncated || terminal.Error != "output_limit_exceeded" {
			t.Fatalf("unexpected output terminal: %#v", terminal)
		}
	})

	t.Run("frame count", func(t *testing.T) {
		manager := processManagerForTest(t, 1024)
		manager.maxOutputFrames = 2
		frames, err := collectCommandFrames(manager, commandRequest{
			CommandID: "frames-1",
			Command:   "for value in 1 2 3 4; do printf x; sleep 0.02; done",
		})
		if err != nil {
			t.Fatal(err)
		}
		terminal := terminalFrame(frames)
		if terminal == nil || !terminal.Truncated || terminal.Error != "output_limit_exceeded" {
			t.Fatalf("unexpected frame-limit terminal: %#v", terminal)
		}
	})
}

func TestNextCommandIsNotKilledByPreviousTerminationSweep(t *testing.T) {
	manager := processManagerForTest(t, 64)
	first, err := collectCommandFrames(manager, commandRequest{
		CommandID: "limited-1",
		Command:   "yes x",
	})
	if err != nil || terminalFrame(first) == nil || !terminalFrame(first).Truncated {
		t.Fatalf("first command did not hit output limit: frames=%#v err=%v", first, err)
	}
	second, err := collectCommandFrames(manager, commandRequest{
		CommandID: "next-1",
		Command:   "printf safe",
	})
	terminal := terminalFrame(second)
	if err != nil || terminal == nil || terminal.ExitCode == nil || *terminal.ExitCode != 0 {
		t.Fatalf("next command was disturbed: frames=%#v err=%v", second, err)
	}
}

func TestCommandCancelIsIdempotent(t *testing.T) {
	manager := processManagerForTest(t, 1024)
	frames := make(chan commandFrame, 16)
	done := make(chan error, 1)
	go func() {
		done <- manager.run(
			context.Background(),
			commandRequest{CommandID: "cancel-1", Command: "sleep 30"},
			func(frame commandFrame) error {
				frames <- frame
				return nil
			},
		)
	}()
	select {
	case frame := <-frames:
		if frame.Type != "start" {
			t.Fatalf("first frame = %#v", frame)
		}
	case <-time.After(time.Second):
		t.Fatal("command did not start")
	}
	cancelResults := make(chan bool, 2)
	for range 2 {
		go func() {
			cancelled, err := manager.cancel(context.Background(), "cancel-1")
			cancelResults <- cancelled && err == nil
		}()
	}
	if !<-cancelResults || !<-cancelResults {
		t.Fatal("repeated cancel should wait for and confirm command cleanup")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	cancelled, err := manager.cancel(context.Background(), "cancel-1")
	if err != nil || cancelled {
		t.Fatal("completed command reported as running")
	}
	close(frames)
	var terminal *commandFrame
	for frame := range frames {
		copy := frame
		if frame.Type == "exit" {
			terminal = &copy
		}
	}
	if terminal == nil || !terminal.Cancelled {
		t.Fatalf("cancel terminal = %#v", terminal)
	}
}

func TestCommandDisconnectTerminatesTheProcess(t *testing.T) {
	manager := processManagerForTest(t, 1024)
	startedAt := time.Now()
	err := manager.run(
		context.Background(),
		commandRequest{CommandID: "disconnect-1", Command: "printf output; sleep 30"},
		func(frame commandFrame) error {
			if frame.Type == "output" {
				return errors.New("peer disconnected")
			}
			return nil
		},
	)
	if err == nil || !strings.Contains(err.Error(), "disconnected") {
		t.Fatalf("disconnect error = %v", err)
	}
	if time.Since(startedAt) > time.Second {
		t.Fatal("disconnected command was not terminated promptly")
	}
}

func TestHTTPDisconnectCleansDetachedDescendant(t *testing.T) {
	if _, err := exec.LookPath("setsid"); err != nil {
		t.Skip("setsid is not installed")
	}
	manager := processManagerForTest(t, 1024)
	fixture := newServerFixture(t)
	fixture.server.commands = manager
	endpoint := httptest.NewServer(fixture.server.handler)
	defer endpoint.Close()

	body, err := json.Marshal(commandRequest{
		CommandID: "disconnect-detached-1",
		Command:   "setsid /bin/bash --noprofile --norc -c 'sleep 30' >/dev/null 2>&1 & pid=$!; start=$(awk '{print $22}' /proc/$pid/stat); printf '%s:%s\\n' \"$pid\" \"$start\"; wait $pid",
	})
	if err != nil {
		t.Fatal(err)
	}
	signed := fixture.request(t, "command", "/v1/commands", body, "")
	request, err := http.NewRequest(http.MethodPost, endpoint.URL+"/v1/commands", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header = signed.Header.Clone()
	response, err := endpoint.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		t.Fatalf("command returned %d", response.StatusCode)
	}

	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 1024), defaultMaxFrameBytes+1)
	var output strings.Builder
	var pid int
	var started uint64
	for scanner.Scan() {
		var frame commandFrame
		if err := json.Unmarshal(scanner.Bytes(), &frame); err != nil {
			response.Body.Close()
			t.Fatal(err)
		}
		if frame.Type != "output" || frame.Stream != "stdout" {
			continue
		}
		output.WriteString(decodedFrameData(t, frame))
		if _, err := fmt.Sscanf(strings.TrimSpace(output.String()), "%d:%d", &pid, &started); err == nil {
			break
		}
	}
	if pid == 0 || started == 0 {
		response.Body.Close()
		t.Fatalf("detached process identity was not streamed: %q (%v)", output.String(), scanner.Err())
	}
	// Closing a non-exhausted response body tears down the HTTP request without
	// calling the authenticated cancel endpoint. request.Context must still drive
	// the same final descendant sweep before the command slot is reusable.
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		current, exists := processStartTime(pid)
		manager.mu.Lock()
		idle := manager.active == nil
		manager.mu.Unlock()
		if (!exists || current != started) && idle {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	current, exists := processStartTime(pid)
	t.Fatalf("HTTP disconnect left detached process %d alive=%t start=%d and command slot occupied", pid, exists && current == started, current)
}

func TestCancelWaitsUntilDetachedDescendantIsGone(t *testing.T) {
	if _, err := exec.LookPath("setsid"); err != nil {
		t.Skip("setsid is not installed")
	}
	manager := processManagerForTest(t, 1024)
	frames := make(chan commandFrame, 16)
	done := make(chan error, 1)
	go func() {
		done <- manager.run(
			context.Background(),
			commandRequest{
				CommandID: "cancel-detached-1",
				Command:   "setsid /bin/bash --noprofile --norc -c 'sleep 30' >/dev/null 2>&1 & pid=$!; start=$(awk '{print $22}' /proc/$pid/stat); printf '%s:%s\\n' \"$pid\" \"$start\"; wait $pid",
			},
			func(frame commandFrame) error {
				frames <- frame
				return nil
			},
		)
	}()

	var pid int
	var started uint64
	deadline := time.After(time.Second)
	for pid == 0 {
		select {
		case frame := <-frames:
			if frame.Type != "output" || frame.Stream != "stdout" {
				continue
			}
			parts := strings.Split(strings.TrimSpace(decodedFrameData(t, frame)), ":")
			if len(parts) != 2 {
				continue
			}
			pid, _ = strconv.Atoi(parts[0])
			started, _ = strconv.ParseUint(parts[1], 10, 64)
		case <-deadline:
			t.Fatal("detached process identity was not emitted")
		}
	}
	cancelled, err := manager.cancel(context.Background(), "cancel-detached-1")
	if err != nil || !cancelled {
		t.Fatalf("cancel result: cancelled=%t err=%v", cancelled, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if current, exists := processStartTime(pid); exists && current == started {
		t.Fatalf("cancel returned while detached process %d was still alive", pid)
	}
}

func TestDetachedDescendantIsCleanedAfterShellExits(t *testing.T) {
	if _, err := exec.LookPath("setsid"); err != nil {
		t.Skip("setsid is not installed")
	}
	manager := processManagerForTest(t, 1024)
	frames, err := collectCommandFrames(manager, commandRequest{
		CommandID: "detached-1",
		Command:   "setsid /bin/bash --noprofile --norc -c 'sleep 30' >/dev/null 2>&1 & echo $!",
	})
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	for _, frame := range frames {
		if frame.Type == "output" && frame.Stream == "stdout" {
			output.WriteString(decodedFrameData(t, frame))
		}
	}
	pid, err := strconv.Atoi(strings.TrimSpace(output.String()))
	if err != nil {
		t.Fatalf("detached pid output %q: %v", output.String(), err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		err = unix.Kill(pid, 0)
		if errors.Is(err, unix.ESRCH) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("detached process %d survived cleanup (kill check: %v)", pid, err)
}

func TestCommandCannotOpenDaemonLogFileDescriptor(t *testing.T) {
	manager := processManagerForTest(t, 1024)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	frames, err := collectCommandFrames(manager, commandRequest{
		CommandID: "log-fd-1",
		Command: fmt.Sprintf(
			"if (printf leaked > /proc/%d/fd/%d) 2>/dev/null; then exit 99; fi; printf blocked",
			os.Getpid(),
			writer.Fd(),
		),
	})
	terminal := terminalFrame(frames)
	if err != nil || terminal == nil || terminal.ExitCode == nil || *terminal.ExitCode != 0 {
		t.Fatalf("command reached daemon log descriptor: frames=%#v err=%v", frames, err)
	}
}

func TestOutputChunkAndHardLimitsAreActuallyBounded(t *testing.T) {
	chunk, err := outputChunkSize(defaultMaxFrameBytes)
	if err != nil || chunk <= 0 || ((chunk+2)/3)*4+512 > defaultMaxFrameBytes {
		t.Fatalf("unsafe output chunk: chunk=%d err=%v", chunk, err)
	}
	bounded := boundedRlimit(unix.Rlimit{Cur: 4096, Max: 8192}, 128)
	if bounded.Cur != 128 || bounded.Max != 128 {
		t.Fatalf("hard limit remained raisable: %#v", bounded)
	}
	alreadyLower := boundedRlimit(unix.Rlimit{Cur: 32, Max: 32}, 64)
	if alreadyLower.Cur != 32 || alreadyLower.Max != 32 {
		t.Fatalf("lower kernel hard limit was raised: %#v", alreadyLower)
	}
}
