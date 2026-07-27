package main

import (
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	logger := log.New(os.Stdout, "sandboxd ", log.LstdFlags|log.LUTC)
	config, err := loadConfig()
	if err != nil {
		logger.Printf("startup status=failed reason=invalid_configuration")
		os.Exit(1)
	}
	if err := validateServerConfig(config); err != nil {
		logger.Printf("startup status=failed reason=invalid_limits")
		os.Exit(1)
	}
	if err := applyProcessLimits(); err != nil {
		logger.Printf("startup status=failed reason=process_limits")
		os.Exit(1)
	}
	app, err := newServer(config)
	if err != nil {
		logger.Printf("startup status=failed reason=sandbox_boundary")
		os.Exit(1)
	}
	defer app.close()

	server := httpServer(config, app.handler)
	stopped := make(chan struct{})
	go func() {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
		defer signal.Stop(signals)
		<-signals
		shutdownServer(server)
		close(stopped)
	}()
	logger.Printf("startup status=ready protocol=%s", protocolVersion)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Printf("server status=failed")
		os.Exit(1)
	}
	select {
	case <-stopped:
	default:
	}
}
