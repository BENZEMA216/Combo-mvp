//go:build !linux

package main

import "errors"

var errFilesystemUnsupported = errors.New("secure workspace filesystem requires Linux openat2")

type workspaceFS struct{}

func newWorkspaceFS(_ string) (*workspaceFS, error) { return nil, errFilesystemUnsupported }
func (fs *workspaceFS) close() error                { return nil }
func (fs *workspaceFS) readFile(_ string, _, _ int64) ([]byte, int64, error) {
	return nil, 0, errFilesystemUnsupported
}
func (fs *workspaceFS) writeFile(_ string, _ []byte, _ bool, _ int64) error {
	return errFilesystemUnsupported
}
func (fs *workspaceFS) editFile(_, _, _ string, _ bool, _ int64) (int, error) {
	return 0, errFilesystemUnsupported
}
