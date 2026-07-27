//go:build !linux

package main

import "os"

func main() { os.Exit(126) }
