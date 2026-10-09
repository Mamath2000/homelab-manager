package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Image reference, normalised like docker does: "nginx" is docker.io/library/nginx:latest.
type imageRef struct {
	Registry string // docker.io, ghcr.io, 192.168.1.5:5000...
	Repo     string // library/nginx
	Tag      string
	Digest   string // set when the reference is pinned (image@sha256:...)
}

var (
	repoRe   = regexp.MustCompile(`^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$`)
	tagRe    = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)
	digestRe = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

func parseRef(s string) (imageRef, error) {
	var r imageRef
	name := s
	if i := strings.IndexByte(name, '@'); i >= 0 {
		r.Digest = name[i+1:]
		name = name[:i]
		if !digestRe.MatchString(r.Digest) {
			return r, fmt.Errorf("invalid digest in %q", s)
		}
	}
	if i := strings.LastIndexByte(name, ':'); i > strings.LastIndexByte(name, '/') {
		r.Tag = name[i+1:]
		name = name[:i]
		if !tagRe.MatchString(r.Tag) {
			return r, fmt.Errorf("invalid tag in %q", s)
		}
	}
	// the first component is a registry when it looks like a host name
	if i := strings.IndexByte(name, '/'); i >= 0 {
		first := name[:i]
		if strings.ContainsAny(first, ".:") || first == "localhost" {
			r.Registry, name = first, name[i+1:]
		}
	}
	if r.Registry == "" || r.Registry == "index.docker.io" || r.Registry == "registry-1.docker.io" {
		r.Registry = "docker.io"
	}
	if r.Registry == "docker.io" && !strings.Contains(name, "/") {
		name = "library/" + name
	}
	if !repoRe.MatchString(name) {
		return r, fmt.Errorf("invalid image name %q", s)
	}
	r.Repo = name
	if r.Tag == "" && r.Digest == "" {
		r.Tag = "latest"
	}
	return r, nil
}

// apiHost is the host serving the registry API.
func (r imageRef) apiHost() string {
	if r.Registry == "docker.io" {
		return "registry-1.docker.io"
	}
	return r.Registry
}

func (r imageRef) sameRepo(o imageRef) bool {
	return r.Registry == o.Registry && r.Repo == o.Repo
}

// localDigest returns the registry digest the local image was pulled from, found among its
// RepoDigests ("nginx@sha256:..."); "" for an image built locally.
func localDigest(ref imageRef, repoDigests []string) string {
	for _, rd := range repoDigests {
		if o, err := parseRef(rd); err == nil && o.Digest != "" && o.sameRepo(ref) {
			return o.Digest
		}
	}
	return ""
}

var manifestTypes = strings.Join([]string{
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
}, ", ")

type registryClient struct {
	http   *http.Client
	scheme string            // https (http in tests)
	auths  map[string]string // registry -> base64 user:password, from the docker config
	tokens map[string]string // realm+service+scope -> bearer token, for one check run
	// registries that may answer over plain http, like docker allows: loopback and the
	// daemon's insecure-registries (https is still tried first)
	insecure map[string]bool
}

func newRegistryClient(insecure map[string]bool) *registryClient {
	return &registryClient{
		http:     &http.Client{Timeout: 20 * time.Second},
		scheme:   "https",
		auths:    loadDockerAuths(),
		tokens:   map[string]string{},
		insecure: insecure,
	}
}

func (c *registryClient) allowsHTTP(registry string) bool {
	host := registry
	if h, _, err := net.SplitHostPort(registry); err == nil {
		host = h
	}
	return c.insecure[registry] || host == "localhost" || strings.HasPrefix(host, "127.") || host == "::1"
}

// loadDockerAuths reads the plain credentials of `docker login` (credential helpers are not used).
func loadDockerAuths() map[string]string {
	auths := map[string]string{}
	dir := os.Getenv("DOCKER_CONFIG")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".docker")
	}
	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return auths
	}
	var cfg struct {
		Auths map[string]struct {
			Auth string `json:"auth"`
		} `json:"auths"`
	}
	if json.Unmarshal(raw, &cfg) != nil {
		return auths
	}
	for host, a := range cfg.Auths {
		if a.Auth == "" {
			continue
		}
		host = strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(host, "https://"), "http://"), "/")
		if host == "index.docker.io/v1" || host == "index.docker.io" || host == "registry-1.docker.io" {
			host = "docker.io"
		}
		auths[host] = a.Auth
	}
	return auths
}

// parseChallenge reads `Bearer realm="...",service="...",scope="..."`.
func parseChallenge(h string) (scheme string, params map[string]string) {
	params = map[string]string{}
	scheme, rest, _ := strings.Cut(strings.TrimSpace(h), " ")
	for rest != "" {
		rest = strings.TrimLeft(rest, " ,")
		key, after, ok := strings.Cut(rest, "=")
		if !ok {
			break
		}
		var val string
		if strings.HasPrefix(after, `"`) {
			end := strings.IndexByte(after[1:], '"')
			if end < 0 {
				val, rest = after[1:], ""
			} else {
				val, rest = after[1:end+1], after[end+2:]
			}
		} else {
			val, rest, _ = strings.Cut(after, ",")
		}
		params[strings.ToLower(strings.TrimSpace(key))] = val
	}
	return strings.ToLower(scheme), params
}

func (c *registryClient) token(ctx context.Context, ref imageRef, params map[string]string) (string, error) {
	realm := params["realm"]
	if realm == "" {
		return "", errors.New("registry authentication without realm")
	}
	scope := params["scope"]
	if scope == "" {
		scope = "repository:" + ref.Repo + ":pull"
	}
	key := realm + "|" + params["service"] + "|" + scope
	if t, ok := c.tokens[key]; ok {
		return t, nil
	}
	u, err := url.Parse(realm)
	if err != nil {
		return "", err
	}
	q := u.Query()
	if params["service"] != "" {
		q.Set("service", params["service"])
	}
	q.Set("scope", scope)
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	if a, ok := c.auths[ref.Registry]; ok {
		req.Header.Set("Authorization", "Basic "+a)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("registry token: HTTP %d", res.StatusCode)
	}
	var body struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil {
		return "", err
	}
	t := body.Token
	if t == "" {
		t = body.AccessToken
	}
	if t == "" {
		return "", errors.New("registry token: empty answer")
	}
	c.tokens[key] = t
	return t, nil
}

func (c *registryClient) manifest(ctx context.Context, method, u, auth string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", manifestTypes)
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	return c.http.Do(req)
}

// remoteDigest returns the digest the tag points to on the registry, with a HEAD request:
// nothing is downloaded and Docker Hub does not count it as a pull.
func (c *registryClient) remoteDigest(ctx context.Context, ref imageRef) (string, error) {
	u := fmt.Sprintf("%s://%s/v2/%s/manifests/%s", c.scheme, ref.apiHost(), ref.Repo, ref.Tag)
	auth := ""
	res, err := c.manifest(ctx, http.MethodHead, u, auth)
	if err != nil && c.scheme == "https" && c.allowsHTTP(ref.Registry) {
		// insecure registry: plain http, as docker itself falls back to
		u = "http" + strings.TrimPrefix(u, "https")
		res, err = c.manifest(ctx, http.MethodHead, u, auth)
	}
	if err != nil {
		return "", err
	}
	res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		scheme, params := parseChallenge(res.Header.Get("WWW-Authenticate"))
		switch scheme {
		case "bearer":
			t, err := c.token(ctx, ref, params)
			if err != nil {
				return "", err
			}
			auth = "Bearer " + t
		case "basic":
			a, ok := c.auths[ref.Registry]
			if !ok {
				return "", errors.New("registry requires a login (docker login)")
			}
			auth = "Basic " + a
		default:
			return "", errors.New("unsupported registry authentication")
		}
		if res, err = c.manifest(ctx, http.MethodHead, u, auth); err != nil {
			return "", err
		}
		res.Body.Close()
	}
	switch {
	case res.StatusCode == http.StatusOK:
	case res.StatusCode == http.StatusNotFound:
		return "", errors.New("tag not found on the registry")
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return "", errors.New("access denied by the registry: private image (docker login) or image not published there")
	case res.StatusCode == http.StatusTooManyRequests:
		return "", errors.New("registry rate limit reached")
	default:
		return "", fmt.Errorf("registry: HTTP %d", res.StatusCode)
	}
	if d := res.Header.Get("Docker-Content-Digest"); digestRe.MatchString(d) {
		return d, nil
	}
	// a few registries only send the digest on GET: hash the manifest ourselves
	res, err = c.manifest(ctx, http.MethodGet, u, auth)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("registry: HTTP %d", res.StatusCode)
	}
	if d := res.Header.Get("Docker-Content-Digest"); digestRe.MatchString(d) {
		return d, nil
	}
	h := sha256.New()
	if _, err := io.Copy(h, io.LimitReader(res.Body, 4<<20)); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), nil
}

// basicAuth encodes credentials like the docker config does (used by tests).
func basicAuth(user, pass string) string {
	return base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
}
