package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseRef(t *testing.T) {
	cases := []struct{ in, registry, repo, tag, digest string }{
		{"nginx", "docker.io", "library/nginx", "latest", ""},
		{"nginx:1.27-alpine", "docker.io", "library/nginx", "1.27-alpine", ""},
		{"linuxserver/sonarr:latest", "docker.io", "linuxserver/sonarr", "latest", ""},
		{"docker.io/library/redis:7", "docker.io", "library/redis", "7", ""},
		{"index.docker.io/library/redis", "docker.io", "library/redis", "latest", ""},
		{"ghcr.io/home-assistant/home-assistant:stable", "ghcr.io", "home-assistant/home-assistant", "stable", ""},
		{"lscr.io/linuxserver/plex", "lscr.io", "linuxserver/plex", "latest", ""},
		{"192.168.1.5:5000/tools/app:v2", "192.168.1.5:5000", "tools/app", "v2", ""},
		{"localhost/app", "localhost", "app", "latest", ""},
		{"nginx@sha256:" + strings.Repeat("a", 64), "docker.io", "library/nginx", "", "sha256:" + strings.Repeat("a", 64)},
	}
	for _, c := range cases {
		r, err := parseRef(c.in)
		if err != nil {
			t.Errorf("%s: %v", c.in, err)
			continue
		}
		if r.Registry != c.registry || r.Repo != c.repo || r.Tag != c.tag || r.Digest != c.digest {
			t.Errorf("%s: got %+v", c.in, r)
		}
	}
	for _, bad := range []string{"", "UPPER/case", "nginx:bad tag", "nginx@sha256:short", "-option"} {
		if _, err := parseRef(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestLocalDigest(t *testing.T) {
	ref, _ := parseRef("nginx:latest")
	d := "sha256:" + strings.Repeat("b", 64)
	if got := localDigest(ref, []string{"ghcr.io/other/nginx@sha256:" + strings.Repeat("c", 64), "nginx@" + d}); got != d {
		t.Fatalf("got %q", got)
	}
	if got := localDigest(ref, nil); got != "" {
		t.Fatalf("local build: got %q", got)
	}
}

func TestParseChallenge(t *testing.T) {
	scheme, p := parseChallenge(`Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"`)
	if scheme != "bearer" || p["realm"] != "https://auth.docker.io/token" || p["service"] != "registry.docker.io" || p["scope"] != "repository:library/nginx:pull" {
		t.Fatalf("got %s %v", scheme, p)
	}
}

// A registry asking for a bearer token, like Docker Hub and ghcr.io.
func TestRemoteDigest(t *testing.T) {
	digest := "sha256:" + strings.Repeat("d", 64)
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/token":
			if r.URL.Query().Get("scope") != "repository:team/app:pull" {
				http.Error(w, "bad scope", http.StatusBadRequest)
				return
			}
			w.Write([]byte(`{"token":"t0k"}`))
		case r.URL.Path == "/v2/team/app/manifests/v1":
			if r.Header.Get("Authorization") != "Bearer t0k" {
				w.Header().Set("WWW-Authenticate", `Bearer realm="`+srv.URL+`/token",service="test"`)
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			if !strings.Contains(r.Header.Get("Accept"), "manifest.list") || r.Method != http.MethodHead {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			w.Header().Set("Docker-Content-Digest", digest)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	host := strings.TrimPrefix(srv.URL, "https://")
	c := &registryClient{http: srv.Client(), scheme: "https", auths: map[string]string{}, tokens: map[string]string{}}

	ref, err := parseRef(host + "/team/app:v1")
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.remoteDigest(context.Background(), ref)
	if err != nil || got != digest {
		t.Fatalf("got %q, %v", got, err)
	}
	missing, _ := parseRef(host + "/team/app:v2")
	if _, err := c.remoteDigest(context.Background(), missing); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("missing tag: %v", err)
	}
}

func TestAllowsHTTP(t *testing.T) {
	c := newRegistryClient(map[string]bool{"nas:5000": true})
	for reg, want := range map[string]bool{"docker.io": false, "ghcr.io": false, "nas:5000": true, "localhost:5000": true, "127.0.0.1:5000": true, "other:5000": false} {
		if got := c.allowsHTTP(reg); got != want {
			t.Errorf("%s: got %v, want %v", reg, got, want)
		}
	}
}

// A plain-http registry on loopback, like a local registry:2 with insecure-registries.
func TestRemoteDigestPlainHTTP(t *testing.T) {
	digest := "sha256:" + strings.Repeat("e", 64)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Docker-Content-Digest", digest)
	}))
	defer srv.Close()
	ref, _ := parseRef(strings.TrimPrefix(srv.URL, "http://") + "/app:latest")
	got, err := newRegistryClient(nil).remoteDigest(context.Background(), ref)
	if err != nil || got != digest {
		t.Fatalf("got %q, %v", got, err)
	}
}
