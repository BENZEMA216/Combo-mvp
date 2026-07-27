package main

import "testing"

func TestValidateWorkspacePath(t *testing.T) {
	valid := []string{"a.txt", "src/main.go", "目录/文件.md"}
	for _, value := range valid {
		if _, err := validateWorkspacePath(value); err != nil {
			t.Fatalf("valid path %q rejected: %v", value, err)
		}
	}

	invalid := []string{
		"",
		"/etc/passwd",
		"../secret",
		"src/../secret",
		"src//main.go",
		"./main.go",
		`src\main.go`,
		"name\x00tail",
	}
	for _, value := range invalid {
		if _, err := validateWorkspacePath(value); err == nil {
			t.Fatalf("invalid path %q accepted", value)
		}
	}
}

func TestValidateWorkspacePathRejectsDepthAndLengthLimits(t *testing.T) {
	tooDeep := "a"
	for range maxPathDepth {
		tooDeep += "/a"
	}
	if _, err := validateWorkspacePath(tooDeep); err == nil {
		t.Fatal("over-deep path accepted")
	}

	tooLong := make([]byte, maxPathBytes+1)
	for index := range tooLong {
		tooLong[index] = 'a'
	}
	if _, err := validateWorkspacePath(string(tooLong)); err == nil {
		t.Fatal("over-long path accepted")
	}
}
