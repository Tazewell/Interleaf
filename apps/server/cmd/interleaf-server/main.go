package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"interleaf.local/server/internal/diagnostics"
	"interleaf.local/server/internal/networkprobe"
	"interleaf.local/server/internal/interleaf"
	"runtime"
	"syscall"
	"time"
)

var interleafVersion = "dev"
var buildCommit = "unknown"

func main() {
	data := flag.String("data", ".interleaf", "local library directory")
	port := flag.String("port", "17840", "loopback port, 0 for automatic")
	web := flag.String("web", "", "built web directory")
	connector := flag.Bool("connector", true, "enable Interleaf Connector listener")
	probeNetwork := flag.Bool("probe-network", false, "check ChatGPT reachability and exit without opening a library")
	logs := flag.String("logs", "", "diagnostic log directory")
	session := flag.String("session", "", "diagnostic session ID")
	migrateLibrary := flag.String("migrate-library", "", "copy a stopped library to a new directory and exit")
	shutdownOnStdin := flag.Bool("shutdown-on-stdin", false, "shut down when the desktop closes stdin")
	flag.Parse()
	if *migrateLibrary != "" {
		if err := interleaf.CopyLibrary(*data, *migrateLibrary); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *probeNetwork {
		_ = json.NewEncoder(os.Stdout).Encode(networkprobe.Run(context.Background()))
		return
	}
	root, err := filepath.Abs(*data)
	if err != nil {
		log.Fatal(err)
	}
	if *logs == "" {
		*logs = filepath.Join(root, "logs")
	}
	recorder, logErr := diagnostics.New(*logs, *session, os.Getenv("INTERLEAF_TOKEN"))
	if logErr == nil {
		slog.SetDefault(recorder.Logger())
	} else {
		log.Printf("local logging unavailable: %v", logErr)
	}
	recorder.Environment = map[string]any{"mode": "server", "appVersion": interleafVersion, "buildCommit": buildCommit, "os": runtime.GOOS, "architecture": runtime.GOARCH, "goVersion": runtime.Version()}
	slog.Info("server.start", "appVersion", interleafVersion, "buildCommit", buildCommit, "goVersion", runtime.Version())
	unlock, err := interleaf.LockLibrary(root)
	if err != nil {
		log.Fatal(err)
	}
	defer unlock()
	store, err := interleaf.OpenStore(root)
	if err != nil {
		log.Fatal(err)
	}
	defer store.DB.Close()
	token := os.Getenv("INTERLEAF_TOKEN")
	if token == "" {
		b := make([]byte, 32)
		if _, err = rand.Read(b); err != nil {
			log.Fatal(err)
		}
		token = hex.EncodeToString(b)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:"+*port)
	if err != nil {
		log.Fatal(err)
	}
	recorder.Secrets = append(recorder.Secrets, token)
	server := interleaf.NewServer(store, token, *web)
	server.SetBibliographyExportCapability(os.Getenv("INTERLEAF_EXPORT_CAPABILITY"))
	_ = os.Unsetenv("INTERLEAF_EXPORT_CAPABILITY")
	server.SetDiagnostics(recorder)
	defer server.Close()
	if !*connector {
		server.SetConnectorUnavailable("disabled")
	} else {
		connectorListener, connectorError := net.Listen("tcp", "127.0.0.1:"+interleaf.ConnectorPort)
		if connectorError != nil {
			server.SetConnectorUnavailable("port-in-use")
			log.Printf("Interleaf Connector unavailable: %v", connectorError)
		} else {
			server.SetConnectorAvailable(true)
			connectorHTTP := &http.Server{Handler: server.ConnectorHandler(), ReadHeaderTimeout: 10 * time.Second}
			go func() { _ = connectorHTTP.Serve(connectorListener) }()
			defer connectorHTTP.Shutdown(context.Background())
		}
	}
	runContext, cancelRun := context.WithCancel(context.Background())
	defer cancelRun()
	stopProcessing := server.StartProcessing(runContext)
	defer stopProcessing()
	stopBibliographyExports := server.StartBibliographyExports(runContext)
	defer stopBibliographyExports()
	httpServer := &http.Server{BaseContext: func(net.Listener) context.Context { return runContext }, Handler: server.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	removeDiscovery, discoveryErr := interleaf.WriteDiscovery(root, interleaf.Discovery{URL: "http://" + listener.Addr().String(), Token: token, PID: os.Getpid(), Version: interleafVersion})
	if discoveryErr != nil {
		log.Printf("command line discovery unavailable: %v", discoveryErr)
	} else {
		defer removeDiscovery()
	}
	ready, _ := json.Marshal(map[string]string{"url": "http://" + listener.Addr().String(), "token": token})
	fmt.Println(string(ready))
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	if *shutdownOnStdin {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			stop <- os.Interrupt
		}()
	}
	go func() {
		<-stop
		slog.Info("server.stopping")
		cancelRun()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
	}()
	if err = httpServer.Serve(listener); err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
