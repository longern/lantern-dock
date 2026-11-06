package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/longern/lantern-dock/server/internal/nas"
)

// Set only in the container build. Standalone binaries keep the caller's identity.
var containerIdentity string

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "lantern-dock:", err)
		os.Exit(1)
	}
}
func parseSize(value string) (int64, error) {
	units := []struct {
		name   string
		factor int64
	}{{"TiB", 1 << 40}, {"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10}, {"TB", 1e12}, {"GB", 1e9}, {"MB", 1e6}, {"KB", 1e3}, {"B", 1}}
	factor := int64(1)
	v := strings.TrimSpace(value)
	for _, unit := range units {
		if strings.HasSuffix(strings.ToLower(v), strings.ToLower(unit.name)) {
			v = strings.TrimSpace(v[:len(v)-len(unit.name)])
			factor = unit.factor
			break
		}
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 || n > (1<<50)/factor {
		return 0, fmt.Errorf("invalid size %q; use bytes, MiB or GiB (maximum 1 PiB)", value)
	}
	return n * factor, nil
}
func siteURL(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil {
		return nil, fmt.Errorf("site must be an HTTPS origin")
	}
	host := u.Hostname()
	local := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if u.Host == "" || u.User != nil || (u.Scheme != "https" && !(u.Scheme == "http" && local)) || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("site must be an HTTPS origin, e.g. https://files.example.com")
	}
	u.Path = "/"
	return u, nil
}
func run(args []string, out io.Writer) error {
	if len(args) == 0 {
		args = []string{"serve"}
	}
	if args[0] == "serve" {
		flags := flag.NewFlagSet("serve", flag.ContinueOnError)
		listen := flags.String("listen", ":8080", "HTTP listen address")
		public := flags.String("public-dir", "./public", "public, read-only WebDAV directory")
		data := flags.String("data-dir", "./data", "private persistent state and inbox directory")
		origins := flags.String("origins", "", "comma-separated allowed frontend origins for direct HTTPS/CORS")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return fmt.Errorf("unexpected serve arguments")
		}
		if err := setupRuntime(*public, *data, true); err != nil {
			return err
		}
		service, err := nas.New(*public, *data, strings.Split(*origins, ","))
		if err != nil {
			return err
		}
		defer service.Close()
		identity, err := nas.IdentityEnvironment(os.Getenv)
		if err != nil {
			return err
		}
		if err = service.ConfigureIdentity(identity); err != nil {
			return err
		}
		listener, err := net.Listen("tcp", *listen)
		if err != nil {
			return err
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		// Upload handlers extend this deadline as bytes arrive; rejected or
		// otherwise small requests must not hold an unread body indefinitely.
		server := &http.Server{Handler: service, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 32 << 10}
		done := make(chan struct{})
		go func() {
			select {
			case <-ctx.Done():
				_ = server.Close()
			case <-done:
			}
		}()
		defer close(done)
		fmt.Fprintf(out, "LanternDock NAS listening on %s; public WebDAV at /dav/\n", listener.Addr())
		err = server.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
	if args[0] != "link" || len(args) < 2 {
		return fmt.Errorf("usage: lantern-dock serve | link create | link list | link revoke")
	}
	flags := flag.NewFlagSet("link "+args[1], flag.ContinueOnError)
	data := flags.String("data-dir", "./data", "private persistent state directory")
	title := flags.String("title", "临时收件箱", "title shown to visitors")
	site := flags.String("site", "", "frontend HTTPS origin (required for create)")
	expiry := flags.Duration("expires", 24*time.Hour, "link lifetime, e.g. 24h or 168h")
	maxFile := flags.String("max-file", "1GiB", "maximum size per file")
	maxTotal := flags.String("max-total", "10GiB", "total quota including active uploads")
	maxFiles := flags.Int64("max-files", 100, "maximum completed and active files")
	if err := flags.Parse(args[2:]); err != nil {
		return err
	}
	if args[1] != "create" && args[1] != "list" && args[1] != "revoke" {
		return fmt.Errorf("unknown link command")
	}
	if (args[1] == "revoke" && flags.NArg() != 1) || (args[1] != "revoke" && flags.NArg() != 0) {
		return fmt.Errorf("revoke requires one link ID; create and list accept flags only")
	}
	var u *url.URL
	var fileBytes, totalBytes int64
	var err error
	if args[1] == "create" {
		u, err = siteURL(*site)
		if err != nil {
			return err
		}
		fileBytes, err = parseSize(*maxFile)
		if err != nil {
			return err
		}
		totalBytes, err = parseSize(*maxTotal)
		if err != nil {
			return err
		}
		if *expiry <= 0 || *expiry > 365*24*time.Hour {
			return fmt.Errorf("expires must be positive and no more than 8760h")
		}
	}
	if err := setupRuntime("/public", *data, false); err != nil {
		return err
	}
	store, err := nas.OpenStore(*data)
	if err != nil {
		return err
	}
	defer store.Close()
	ctx := context.Background()
	encoder := json.NewEncoder(out)
	encoder.SetIndent("", "  ")
	switch args[1] {
	case "create":
		l, token, err := store.CreateLink(ctx, nas.Link{Title: *title, ExpiresAt: time.Now().Add(*expiry), MaxFileBytes: fileBytes, MaxTotalBytes: totalBytes, MaxFiles: *maxFiles})
		if err != nil {
			return err
		}
		u.Fragment = "/upload/" + token
		return encoder.Encode(struct {
			Link nas.Link `json:"link"`
			URL  string   `json:"url"`
		}{l, u.String()})
	case "list":
		links, err := store.ListLinks(ctx)
		if err != nil {
			return err
		}
		return encoder.Encode(links)
	case "revoke":
		if err = store.Revoke(ctx, flags.Arg(0)); err != nil {
			return err
		}
		return encoder.Encode(map[string]string{"id": flags.Arg(0), "status": "revoked"})
	}
	return nil
}
