//go:build linux

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func newWorkspaceForTest(t *testing.T) (*workspaceFS, string) {
	t.Helper()
	root := t.TempDir()
	workspace, err := newWorkspaceFS(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = workspace.close() })
	return workspace, root
}

func TestWorkspaceAtomicWriteReadAndEdit(t *testing.T) {
	workspace, root := newWorkspaceForTest(t)
	if err := workspace.writeFile("src/note.txt", []byte("alpha beta"), true, 1024); err != nil {
		t.Fatal(err)
	}
	data, size, err := workspace.readFile("src/note.txt", 0, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "alpha beta" || size != 10 {
		t.Fatalf("unexpected read: %q size=%d", data, size)
	}
	count, err := workspace.editFile("src/note.txt", "beta", "gamma", false, 1024)
	if err != nil || count != 1 {
		t.Fatalf("edit failed: count=%d err=%v", count, err)
	}
	persisted, err := os.ReadFile(filepath.Join(root, "src", "note.txt"))
	if err != nil || string(persisted) != "alpha gamma" {
		t.Fatalf("unexpected persisted content: %q err=%v", persisted, err)
	}
	entries, err := os.ReadDir(filepath.Join(root, "src"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".sandboxd-") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
}

func TestWorkspaceRejectsTraversalAndSymlinks(t *testing.T) {
	workspace, root := newWorkspaceForTest(t)
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := workspace.readFile("../outside.txt", 0, 1024); !errors.Is(err, errInvalidPath) {
		t.Fatalf("traversal error = %v", err)
	}
	if _, _, err := workspace.readFile("link.txt", 0, 1024); err == nil {
		t.Fatal("read followed a symlink")
	}
	if err := workspace.writeFile("link.txt", []byte("changed"), false, 1024); !errors.Is(err, unix.ELOOP) {
		t.Fatalf("write symlink error = %v", err)
	}
	content, err := os.ReadFile(outside)
	if err != nil || string(content) != "secret" {
		t.Fatalf("outside file changed: %q err=%v", content, err)
	}
	if err := os.Mkdir(filepath.Join(root, "real"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "real"), filepath.Join(root, "parent-link")); err != nil {
		t.Fatal(err)
	}
	if err := workspace.writeFile("parent-link/file.txt", []byte("no"), false, 1024); err == nil {
		t.Fatal("write traversed a symlink parent")
	}
}

func TestWorkspaceEditPreconditionsAndLimits(t *testing.T) {
	workspace, _ := newWorkspaceForTest(t)
	if err := workspace.writeFile("note.txt", []byte("same same"), false, 1024); err != nil {
		t.Fatal(err)
	}
	if _, err := workspace.editFile("note.txt", "same", "new", false, 1024); err == nil || !strings.Contains(err.Error(), "not unique") {
		t.Fatalf("non-unique edit error = %v", err)
	}
	count, err := workspace.editFile("note.txt", "same", "new", true, 1024)
	if err != nil || count != 2 {
		t.Fatalf("replace all failed: count=%d err=%v", count, err)
	}
	if err := workspace.writeFile("large.txt", []byte("12345"), false, 4); err == nil {
		t.Fatal("oversized write was accepted")
	}
	if err := workspace.writeFile("binary.txt", []byte{0xff, 0xfe}, false, 1024); err != nil {
		t.Fatal(err)
	}
	if _, err := workspace.editFile("binary.txt", "x", "y", false, 1024); err == nil || !strings.Contains(err.Error(), "UTF-8") {
		t.Fatalf("binary edit error = %v", err)
	}
}
