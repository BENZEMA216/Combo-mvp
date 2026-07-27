//go:build linux

// sandbox-exec applies a Landlock write allowlist before starting untrusted bash.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

const minimumLandlockABI = 3

type landlockRulesetAttr struct {
	HandledAccessFS uint64
}

type landlockPathBeneathAttr struct {
	AllowedAccess uint64
	ParentFD      int32
	_             uint32
}

const handledWriteAccess = uint64(
	unix.LANDLOCK_ACCESS_FS_WRITE_FILE |
		unix.LANDLOCK_ACCESS_FS_REMOVE_DIR |
		unix.LANDLOCK_ACCESS_FS_REMOVE_FILE |
		unix.LANDLOCK_ACCESS_FS_MAKE_CHAR |
		unix.LANDLOCK_ACCESS_FS_MAKE_DIR |
		unix.LANDLOCK_ACCESS_FS_MAKE_REG |
		unix.LANDLOCK_ACCESS_FS_MAKE_SOCK |
		unix.LANDLOCK_ACCESS_FS_MAKE_FIFO |
		unix.LANDLOCK_ACCESS_FS_MAKE_BLOCK |
		unix.LANDLOCK_ACCESS_FS_MAKE_SYM |
		unix.LANDLOCK_ACCESS_FS_REFER |
		unix.LANDLOCK_ACCESS_FS_TRUNCATE,
)

func landlockABI() (int, error) {
	version, _, errno := unix.Syscall(
		unix.SYS_LANDLOCK_CREATE_RULESET,
		0,
		0,
		unix.LANDLOCK_CREATE_RULESET_VERSION,
	)
	if errno != 0 {
		return 0, errno
	}
	return int(version), nil
}

func createRuleset() (int, error) {
	attribute := landlockRulesetAttr{HandledAccessFS: handledWriteAccess}
	fd, _, errno := unix.Syscall(
		unix.SYS_LANDLOCK_CREATE_RULESET,
		uintptr(unsafe.Pointer(&attribute)),
		unsafe.Sizeof(attribute),
		0,
	)
	if errno != 0 {
		return -1, errno
	}
	return int(fd), nil
}

func addPathRule(rulesetFD int, path string, allowed uint64) error {
	pathFD, err := unix.Open(path, unix.O_PATH|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(pathFD)
	attribute := landlockPathBeneathAttr{AllowedAccess: allowed, ParentFD: int32(pathFD)}
	_, _, errno := unix.Syscall(
		unix.SYS_LANDLOCK_ADD_RULE,
		uintptr(rulesetFD),
		unix.LANDLOCK_RULE_PATH_BENEATH,
		uintptr(unsafe.Pointer(&attribute)),
	)
	if errno != 0 {
		return errno
	}
	return nil
}

func applyWriteBoundary(workspace string) error {
	cleanWorkspace := filepath.Clean(workspace)
	if !filepath.IsAbs(cleanWorkspace) || cleanWorkspace == "/" {
		return errors.New("workspace must be an absolute non-root path")
	}
	abi, err := landlockABI()
	if err != nil || abi < minimumLandlockABI {
		return fmt.Errorf("Landlock ABI 3 is required")
	}
	rulesetFD, err := createRuleset()
	if err != nil {
		return err
	}
	defer unix.Close(rulesetFD)
	for _, path := range []string{cleanWorkspace, "/tmp"} {
		if err := addPathRule(rulesetFD, path, handledWriteAccess); err != nil {
			return err
		}
	}
	if err := addPathRule(rulesetFD, "/dev/null", unix.LANDLOCK_ACCESS_FS_WRITE_FILE); err != nil {
		return err
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return err
	}
	_, _, errno := unix.Syscall(unix.SYS_LANDLOCK_RESTRICT_SELF, uintptr(rulesetFD), 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

func main() {
	if len(os.Args) != 3 {
		os.Exit(126)
	}
	workspace := os.Args[1]
	if err := applyWriteBoundary(workspace); err != nil {
		os.Exit(126)
	}
	if err := os.Chdir(workspace); err != nil {
		os.Exit(126)
	}
	if err := syscall.Exec(
		"/bin/bash",
		[]string{"/bin/bash", "--noprofile", "--norc", "-lc", os.Args[2]},
		os.Environ(),
	); err != nil {
		os.Exit(126)
	}
}
