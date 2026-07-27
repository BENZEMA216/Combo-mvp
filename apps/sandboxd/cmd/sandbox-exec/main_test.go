//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestLandlockSubprocess(t *testing.T) {
	if os.Getenv("SANDBOX_EXEC_LANDLOCK_HELPER") != "1" {
		return
	}
	workspace := os.Getenv("SANDBOX_EXEC_TEST_WORKSPACE")
	outside := os.Getenv("SANDBOX_EXEC_TEST_OUTSIDE")
	if err := applyWriteBoundary(workspace); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(10)
	}
	if err := os.WriteFile(filepath.Join(workspace, "allowed.txt"), []byte("ok"), 0o600); err != nil {
		os.Exit(11)
	}
	if err := os.WriteFile(outside, []byte("leak"), 0o600); err == nil {
		os.Exit(12)
	}
	if err := os.WriteFile("/dev/null", []byte("ok"), 0o600); err != nil {
		os.Exit(13)
	}
	os.Exit(0)
}

func TestLandlockAllowsOnlyWorkspaceTmpAndDevNullWrites(t *testing.T) {
	workspace := t.TempDir()
	outsideDirectory := "/dev/shm"
	if info, err := os.Stat(outsideDirectory); err != nil || !info.IsDir() {
		t.Skip("/dev/shm is unavailable")
	}
	outside := filepath.Join(outsideDirectory, fmt.Sprintf("sandbox-exec-%d", os.Getpid()))
	if err := os.WriteFile(outside, []byte("sentinel"), 0o666); err != nil {
		t.Skipf("cannot prepare outside file: %v", err)
	}
	defer os.Remove(outside)

	command := exec.Command(os.Args[0], "-test.run=^TestLandlockSubprocess$")
	command.Env = append(
		os.Environ(),
		"SANDBOX_EXEC_LANDLOCK_HELPER=1",
		"SANDBOX_EXEC_TEST_WORKSPACE="+workspace,
		"SANDBOX_EXEC_TEST_OUTSIDE="+outside,
	)
	if output, err := command.CombinedOutput(); err != nil {
		if string(output) == "Landlock ABI 3 is required\n" {
			t.Skip("host kernel does not expose Landlock ABI 3")
		}
		t.Fatalf("Landlock helper failed: %v: %s", err, output)
	}
	contents, err := os.ReadFile(outside)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "sentinel" {
		t.Fatalf("outside file changed to %q", contents)
	}
}
