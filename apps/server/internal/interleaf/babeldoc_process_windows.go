package interleaf

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

func configureBabelDOCCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Cancel = func() error {
		if systemRoot := os.Getenv("SystemRoot"); filepath.IsAbs(systemRoot) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			stop := exec.CommandContext(ctx, filepath.Join(systemRoot, "System32", "taskkill.exe"), "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
			stop.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
			if stop.Run() == nil {
				return nil
			}
		}
		return cmd.Process.Kill()
	}
}
