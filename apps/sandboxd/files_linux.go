//go:build linux

package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

var errFilesystemUnsupported = errors.New("secure workspace filesystem requires Linux openat2")

type workspaceFS struct {
	rootFD int
}

const secureResolve = unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS

func newWorkspaceFS(root string) (*workspaceFS, error) {
	rootFD, err := unix.Open(root, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("open workspace: %w", err)
	}
	// Probe openat2 at startup. Unsupported kernels fail closed; there is deliberately no realpath fallback.
	probe, err := unix.Openat2(rootFD, ".", &unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC,
		Resolve: secureResolve,
	})
	if err != nil {
		unix.Close(rootFD)
		if errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EINVAL) {
			return nil, errFilesystemUnsupported
		}
		return nil, fmt.Errorf("probe workspace: %w", err)
	}
	unix.Close(probe)
	return &workspaceFS{rootFD: rootFD}, nil
}

func (fs *workspaceFS) close() error { return unix.Close(fs.rootFD) }

func (fs *workspaceFS) open(relative string, flags int, mode uint32) (int, error) {
	return unix.Openat2(fs.rootFD, relative, &unix.OpenHow{
		Flags:   uint64(flags | unix.O_CLOEXEC),
		Mode:    uint64(mode),
		Resolve: secureResolve,
	})
}

func regularFileSize(fd int) (int64, error) {
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return 0, err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG {
		return 0, errors.New("workspace entry is not a regular file")
	}
	return stat.Size, nil
}

func (fs *workspaceFS) readFile(relative string, offset, limit int64) ([]byte, int64, error) {
	if _, err := validateWorkspacePath(relative); err != nil {
		return nil, 0, err
	}
	if offset < 0 || limit <= 0 {
		return nil, 0, errors.New("invalid read range")
	}
	fd, err := fs.open(relative, unix.O_RDONLY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, 0, err
	}
	size, err := regularFileSize(fd)
	if err != nil {
		unix.Close(fd)
		return nil, 0, err
	}
	if offset > size {
		offset = size
	}
	if _, err := unix.Seek(fd, offset, io.SeekStart); err != nil {
		unix.Close(fd)
		return nil, 0, err
	}
	file := os.NewFile(uintptr(fd), relative)
	if file == nil {
		unix.Close(fd)
		return nil, 0, errors.New("open file handle failed")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	closeErr := file.Close()
	if err != nil {
		return nil, 0, err
	}
	if closeErr != nil {
		return nil, 0, closeErr
	}
	if int64(len(data)) > limit {
		data = data[:limit]
	}
	return data, size, nil
}

func openDirectoryAt(parentFD int, name string) (int, error) {
	return unix.Openat2(parentFD, name, &unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC,
		Resolve: secureResolve,
	})
}

func (fs *workspaceFS) openParent(parts []string, create bool) (int, string, error) {
	// Open a fresh close-on-exec descriptor instead of Dup, which clears FD_CLOEXEC.
	// File APIs and commands are serialized by the caller, but the descriptor must
	// still be safe if a request is cancelled while a process is starting.
	parentFD, err := openDirectoryAt(fs.rootFD, ".")
	if err != nil {
		return -1, "", err
	}
	for _, part := range parts[:len(parts)-1] {
		nextFD, openErr := openDirectoryAt(parentFD, part)
		if openErr != nil && create && errors.Is(openErr, unix.ENOENT) {
			if mkdirErr := unix.Mkdirat(parentFD, part, 0o700); mkdirErr != nil && !errors.Is(mkdirErr, unix.EEXIST) {
				unix.Close(parentFD)
				return -1, "", mkdirErr
			}
			nextFD, openErr = openDirectoryAt(parentFD, part)
		}
		if openErr != nil {
			unix.Close(parentFD)
			return -1, "", openErr
		}
		unix.Close(parentFD)
		parentFD = nextFD
	}
	return parentFD, parts[len(parts)-1], nil
}

func temporaryName() (string, error) {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return ".sandboxd-" + hex.EncodeToString(raw[:]) + ".tmp", nil
}

func writeAll(fd int, data []byte) error {
	for len(data) > 0 {
		written, err := unix.Write(fd, data)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		data = data[written:]
	}
	return nil
}

func atomicWriteAt(parentFD int, base string, data []byte) error {
	var existing unix.Stat_t
	if err := unix.Fstatat(parentFD, base, &existing, unix.AT_SYMLINK_NOFOLLOW); err == nil {
		if existing.Mode&unix.S_IFMT == unix.S_IFLNK {
			return unix.ELOOP
		}
	} else if !errors.Is(err, unix.ENOENT) {
		return err
	}
	temp, err := temporaryName()
	if err != nil {
		return err
	}
	fd, err := unix.Openat(
		parentFD,
		temp,
		unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC,
		0o600,
	)
	if err != nil {
		return err
	}
	keep := false
	defer func() {
		unix.Close(fd)
		if !keep {
			_ = unix.Unlinkat(parentFD, temp, 0)
		}
	}()
	if err := writeAll(fd, data); err != nil {
		return err
	}
	if err := unix.Fsync(fd); err != nil {
		return err
	}
	if err := unix.Renameat(parentFD, temp, parentFD, base); err != nil {
		return err
	}
	keep = true
	// Directory fsync is best effort on filesystems that reject it (for example some gVisor versions).
	_ = unix.Fsync(parentFD)
	return nil
}

func (fs *workspaceFS) writeFile(relative string, data []byte, createParents bool, maximum int64) error {
	parts, err := validateWorkspacePath(relative)
	if err != nil {
		return err
	}
	if int64(len(data)) > maximum {
		return errors.New("file content exceeds limit")
	}
	parentFD, base, err := fs.openParent(parts, createParents)
	if err != nil {
		return err
	}
	defer unix.Close(parentFD)
	return atomicWriteAt(parentFD, base, data)
}

func (fs *workspaceFS) editFile(relative, oldText, newText string, replaceAll bool, maximum int64) (int, error) {
	parts, err := validateWorkspacePath(relative)
	if err != nil {
		return 0, err
	}
	if oldText == "" {
		return 0, errors.New("old text must not be empty")
	}
	fd, err := fs.open(relative, unix.O_RDONLY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return 0, err
	}
	size, err := regularFileSize(fd)
	if err != nil {
		unix.Close(fd)
		return 0, err
	}
	if size > maximum {
		unix.Close(fd)
		return 0, errors.New("file content exceeds limit")
	}
	file := os.NewFile(uintptr(fd), relative)
	if file == nil {
		unix.Close(fd)
		return 0, errors.New("open file handle failed")
	}
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	closeErr := file.Close()
	if err != nil {
		return 0, err
	}
	if closeErr != nil {
		return 0, closeErr
	}
	if int64(len(data)) > maximum {
		return 0, errors.New("file content exceeds limit")
	}
	if !utf8.Valid(data) {
		return 0, errors.New("file content is not UTF-8 text")
	}
	count := bytes.Count(data, []byte(oldText))
	if count == 0 {
		return 0, errors.New("old text not found")
	}
	if !replaceAll && count != 1 {
		return 0, errors.New("old text is not unique")
	}
	var edited []byte
	if replaceAll {
		edited = bytes.ReplaceAll(data, []byte(oldText), []byte(newText))
	} else {
		edited = []byte(strings.Replace(string(data), oldText, newText, 1))
	}
	if int64(len(edited)) > maximum {
		return 0, errors.New("edited file exceeds limit")
	}
	parentFD, base, err := fs.openParent(parts, false)
	if err != nil {
		return 0, err
	}
	defer unix.Close(parentFD)
	if err := atomicWriteAt(parentFD, base, edited); err != nil {
		return 0, err
	}
	if replaceAll {
		return count, nil
	}
	return 1, nil
}
