//go:build !linux

package main

import (
	"context"
	"errors"
)

var (
	errProcessUnsupported = errors.New("sandbox process control requires Linux")
	errProcessCleanup     = errors.New("sandbox descendant cleanup failed")
)

type commandManager struct{}

func newCommandManager(_ Config) (*commandManager, error) { return nil, errProcessUnsupported }
func (manager *commandManager) run(_ context.Context, _ commandRequest, _ func(commandFrame) error) error {
	return errProcessUnsupported
}
func (manager *commandManager) cancel(_ context.Context, _ string) (bool, error) {
	return false, errProcessUnsupported
}
func (manager *commandManager) close() {}
func applyProcessLimits() error        { return errProcessUnsupported }
