package library

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

//go:embed image_gpu.py
var imageScript string

type imageEvent struct {
	Done  bool   `json:"done"`
	Error string `json:"error"`
	Step  string `json:"step"`
}
type imageWorker struct {
	cmd    *exec.Cmd
	input  io.WriteCloser
	events chan imageEvent
	done   chan struct{}
	err    error
}

func imagePython() string {
	if path := os.Getenv("CURIO_IMAGE_PYTHON"); path != "" {
		return path
	}
	return "/opt/curio/bin/image-gpu/bin/python"
}

func startImageWorker() (*imageWorker, error) {
	cmd := exec.Command(imagePython(), "-B", "-u", "-c", imageScript)
	cmd.Env = append(os.Environ(), "PYTHONNOUSERSITE=1", "OPENBLAS_NUM_THREADS=1", "OMP_NUM_THREADS=2")
	cmd.WaitDelay = 5 * time.Second
	stderr := &boundedBuffer{maximum: 4096}
	cmd.Stderr = stderr
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		input.Close()
		return nil, err
	}
	w := &imageWorker{cmd: cmd, input: input, events: make(chan imageEvent, 16), done: make(chan struct{})}
	go func() {
		scanner := bufio.NewScanner(output)
		for scanner.Scan() {
			var event imageEvent
			if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
				w.err = err
				_ = cmd.Process.Kill()
				break
			}
			w.events <- event
		}
		if err := cmd.Wait(); err != nil {
			w.err = fmt.Errorf("NVIDIA image worker: %w: %s", err, strings.TrimSpace(stderr.String()))
		}
		close(w.events)
		close(w.done)
	}()
	return w, nil
}
func (w *imageWorker) stop() { _ = w.input.Close(); _ = w.cmd.Process.Kill(); <-w.done }
func (l *Library) closeImageWorkers() {
	l.imageMu.Lock()
	defer l.imageMu.Unlock()
	for _, w := range l.imageWorkers {
		w.stop()
	}
	l.imageWorkers = nil
}

func (l *Library) runImageGPU(ctx context.Context, a *Asset, request map[string]string, engine string) error {
	release, err := l.acquireGPU(ctx)
	if err != nil {
		return err
	}
	defer release()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	var w *imageWorker
	l.imageMu.Lock()
	for len(l.imageWorkers) > 0 {
		index := len(l.imageWorkers) - 1
		candidate := l.imageWorkers[index]
		l.imageWorkers = l.imageWorkers[:index]
		select {
		case <-candidate.done:
			_ = candidate.input.Close()
		default:
			w = candidate
		}
		if w != nil {
			break
		}
	}
	l.imageMu.Unlock()
	if w == nil {
		w, err = startImageWorker()
		if err != nil {
			return err
		}
	}
	interrupted := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { _ = w.cmd.Process.Kill(); _ = w.input.Close(); close(interrupted) })
	healthy := true
	defer func() {
		if !stop() {
			<-interrupted
		}
		if ctx.Err() != nil || !healthy {
			w.stop()
		} else {
			l.imageMu.Lock()
			l.imageWorkers = append(l.imageWorkers, w)
			l.imageMu.Unlock()
		}
	}()
	if err = json.NewEncoder(w.input).Encode(request); err != nil {
		healthy = false
		return err
	}
	for {
		select {
		case <-ctx.Done():
			healthy = false
			return ctx.Err()
		case event, ok := <-w.events:
			if !ok {
				healthy = false
				return fmt.Errorf("NVIDIA image worker stopped: %v", w.err)
			}
			if event.Step != "" {
				l.stage(a.ID, event.Step, engine, 0)
			}
			if event.Done {
				if event.Error != "" {
					return fmt.Errorf("NVIDIA image worker: %s", event.Error)
				}
				return nil
			}
		}
	}
}

func (l *Library) imageGPU(ctx context.Context, a *Asset, metadata map[string]any, input, work string) error {
	if os.Getenv("CURIO_GPU") == "cpu" {
		return fmt.Errorf("GPU 已按配置关闭")
	}
	if _, err := exec.LookPath(imagePython()); err != nil {
		return fmt.Errorf("NVIDIA 图片运行时不可用")
	}
	if a.Width < 1 || a.Height < 1 || int64(a.Width)*int64(a.Height) > 80_000_000 {
		return fmt.Errorf("图片超过 GPU 工作集限制")
	}
	request := map[string]string{"source": input, "preview": filepath.Join(work, "preview.jpg"), "thumbnail": filepath.Join(work, "thumbnail.jpg")}
	profile := false
	for key := range metadata {
		if strings.HasPrefix(key, "ICC") || strings.Contains(key, "ProfileDescription") {
			profile = true
			break
		}
	}
	if a.MIME == "image/jpeg" && !profile && metaNumber(metadata, "ColorComponents") != 4 {
		if err := l.runImageGPU(ctx, a, request, "NVIDIA GPU"); err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	rgb := filepath.Join(work, "gpu-source.ppm")
	if _, err := l.cpuCommand(ctx, "vips", "thumbnail", input, rgb+"[strip,format=ppm]", strconv.Itoa(max(a.Width, a.Height)), "--size", "down"); err != nil {
		return err
	}
	request["rgb"] = rgb
	return l.runImageGPU(ctx, a, request, "NVIDIA GPU · CPU 解码/色彩转换")
}
