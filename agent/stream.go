package main

import (
	"bufio"
	"context"
	"io"
	"os/exec"
	"strings"
)

// runStreaming runs a command with the given environment, forwarding each output line to emit.
func runStreaming(ctx context.Context, env []string, emit func(string), name string, args ...string) (int, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = env
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			// apt and docker redraw progress with carriage returns: keep only the final state of the line
			line := strings.TrimRight(sc.Text(), "\r")
			if i := strings.LastIndexByte(line, '\r'); i >= 0 {
				line = line[i+1:]
			}
			emit(line + "\n")
		}
	}()
	err := cmd.Start()
	if err != nil {
		pw.Close()
		<-done
		return -1, err
	}
	err = cmd.Wait()
	pw.Close()
	<-done
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode(), nil
		}
		return -1, err
	}
	return 0, nil
}
