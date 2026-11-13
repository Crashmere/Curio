package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Crashmere/Curio/internal/library"
	"github.com/Crashmere/Curio/web"
)

func main() {
	if err := run(); err != nil {
		slog.Error("Curio", "error", err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: curio init|serve|check|recalculate-screenshot-times [--data PATH]")
	}
	name := os.Args[1]
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	data := flags.String("data", "data", "library data directory")
	listen := flags.String("listen", "127.0.0.1:18088", "loopback listener")
	workers := flags.Int("workers", 2, "parallel media jobs (1-8)")
	gpu := flags.Int("gpu-slots", 1, "simultaneous GPU operations")
	full := flags.Bool("full", false, "verify original SHA-256 checksums")
	var apply, assigned, missingOnly *bool
	if name == "recalculate-screenshot-times" {
		apply = flags.Bool("apply", false, "replace capture times for selected live game media in both visibility scopes; default is read-only preview")
		assigned = flags.Bool("assigned", false, "select media already in game folders instead of unassigned game media")
		missingOnly = flags.Bool("missing-only", false, "fill only unknown capture times; preserve every already known time")
	}
	if err := flags.Parse(os.Args[2:]); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if name == "check" {
		return library.CheckData(ctx, *data, *full)
	}
	if name == "recalculate-screenshot-times" {
		result, err := library.RecalculateScreenshotTimes(ctx, *data, *apply, *assigned, *missingOnly)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(result)
	}
	var l *library.Library
	var err error
	if name == "init" {
		l, err = library.Init(*data)
	} else if name == "serve" {
		l, err = library.Open(*data)
	} else {
		return fmt.Errorf("unknown command: %s", name)
	}
	if err != nil {
		return err
	}
	defer l.DB.Close()
	if name == "init" {
		return l.Check(ctx, false)
	}
	if err = l.Configure(*workers, *gpu); err != nil {
		return err
	}
	if err = l.StartPlayback(ctx); err != nil {
		return err
	}
	defer l.ClosePlayback()
	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("listener must use a loopback IP address")
	}
	assets, err := fs.Sub(web.Files, "dist")
	if err != nil {
		return err
	}
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); l.Worker(ctx) }()
	server := &http.Server{Addr: *listen, Handler: l.Handler(assets), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 64 << 10}
	shutdownDone := make(chan struct{})
	go func() {
		<-ctx.Done()
		deadline, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = server.Shutdown(deadline)
		_ = server.Close()
		close(shutdownDone)
	}()
	slog.Info("Curio listening", "address", *listen, "workers", l.Workers, "gpuSlots", cap(l.GPU), "cpuOperations", cap(l.CPU))
	err = server.ListenAndServe()
	stop()
	<-shutdownDone
	<-workerDone
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
