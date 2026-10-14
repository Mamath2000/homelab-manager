package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// match_list.rs tests (file types, anchoring, path relativity), on the entries of the client.
func TestMatchList(t *testing.T) {
	list, err := compileExcludes([]string{"a_dir/", "!a_file", "!another_dir//"})
	if err != nil {
		t.Fatal(err)
	}
	// parse_pattern(…, Include) in the test of pathpatterns: our entries are Exclude, so inverted
	verdict := func(p string, dir bool) int { return matchList(list, p, dir) }
	if verdict("a_dir", true) != 1 || verdict("/a_dir", true) != 1 || verdict("/a_dir", false) != 0 {
		t.Error("a_dir/")
	}
	if verdict("/a_file", false) != 2 {
		t.Error("!a_file")
	}
	if verdict("/another_dir", true) != 2 || verdict("/another_dir", false) != 0 {
		t.Error("!another_dir//")
	}

	anchored := []matchEntry{mustEntry(t, "file-a", false), mustEntry(t, "some/path", true)}
	cases := []struct {
		p    string
		want int
	}{
		{"file-a", 1}, {"another/file-a", 1}, {"some", 0}, {"path", 0}, {"some/path", 1}, {"another/some/path", 0},
	}
	for _, c := range cases {
		if got := matchList(anchored, c.p, false); got != c.want {
			t.Errorf("anchored %q: got %d, want %d", c.p, got, c.want)
		}
	}

	rel := []matchEntry{mustEntry(t, "noslash", false), mustEntry(t, "noslash-a", true), mustEntry(t, "/slash", false), mustEntry(t, "/slash-a", true)}
	for p, want := range map[string]int{
		"noslash": 1, "noslash-a": 1, "slash": 0, "/slash": 1, "slash-a": 0, "/slash-a": 1,
		"foo/noslash": 1, "foo/noslash-a": 0, "foo/slash": 0, "foo/slash-a": 0,
	} {
		if got := matchList(rel, p, false); got != want {
			t.Errorf("relativity %q: got %d, want %d", p, got, want)
		}
	}
}

func mustEntry(t *testing.T, p string, anchored bool) matchEntry {
	t.Helper()
	e, err := parseMatchEntry(p)
	if err != nil {
		t.Fatal(err)
	}
	e.anchored = anchored
	return e
}

func TestCompileExcludes(t *testing.T) {
	pats, err := compileExcludes([]string{"**/.cache", "/tmp/", "*.log", "node_modules", "!keep.log", "./data/./x/../[ab]?"})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		rel  string
		dir  bool
		want int
	}{
		{"/.cache", true, 1},
		{"/a/b/.cache", true, 1},
		{"/a/.cachex", true, 0},
		{"/tmp", true, 1},
		{"/tmp", false, 0},  // trailing '/': directories only
		{"/a/tmp", true, 0}, // leading '/': from the root only
		{"/x.log", false, 1},
		{"/a/b/x.log", false, 1},
		{"/a/keep.log", false, 2}, // re-included by the last pattern
		{"/a/node_modules", true, 1},
		{"/data/a1", true, 1}, // normalized: data/[ab]?
		{"/data/c1", true, 0},
	}
	for _, c := range cases {
		if got := matchList(pats, c.rel, c.dir); got != c.want {
			t.Errorf("%s dir=%v: got %d, want %d", c.rel, c.dir, got, c.want)
		}
	}
	for _, bad := range []string{"a[", `a\`, "a[[:nope:]]"} {
		if _, err := compileExcludes([]string{bad}); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestEstimateDirectories(t *testing.T) {
	root := t.TempDir()
	big := func(n int) string { return string(make([]byte, n)) }
	writeTree(t, root, map[string]string{
		"a.bin":           big(100),
		"sub/c.txt":       big(10),
		"cache/b.bin":     big(500),
		"sub/cache/d.bin": big(50),
		// .pxarexclude of sub: '/x' anchored on sub, 'y' anywhere below sub
		"sub/.pxarexclude": "# comment\n  /x  \ny\n",
		"sub/x/e.bin":      big(7),
		"sub/z/y":          big(3),
		"x/f.bin":          big(20), // not under sub: kept
		"y":                big(30), // the .pxarexclude of sub does not apply here
	})
	// hard link: counted once
	if err := os.Link(filepath.Join(root, "a.bin"), filepath.Join(root, "a-link.bin")); err != nil {
		t.Fatal(err)
	}
	res, err := estimateDirectories(context.Background(), []BackupArchive{{Name: "t", Path: root}}, []string{"**/cache"})
	if err != nil {
		t.Fatal(err)
	}
	r := res[0]
	// kept: a.bin 100 (+ link 0), sub/c.txt 10, sub/.pxarexclude 19, x/f.bin 20, y 30
	if r.Files != 6 || r.Size != 100+10+19+20+30 {
		t.Errorf("kept: %d files, %d bytes", r.Files, r.Size)
	}
	// excluded: cache 500, sub/cache 50, sub/x 7, sub/z/y 3
	if r.Excluded.Files != 4 || r.Excluded.Size != 560 {
		t.Errorf("excluded: %d files, %d bytes", r.Excluded.Files, r.Excluded.Size)
	}
	if len(r.Excluded.Top) != 4 || r.Excluded.Top[0].Path != "/cache" || r.Excluded.Top[0].Size != 500 || !r.Excluded.Top[0].Dir {
		t.Errorf("top: %+v", r.Excluded.Top)
	}

	if _, err := estimateDirectories(context.Background(), []BackupArchive{{Name: "t", Path: "rel"}}, nil); err == nil {
		t.Error("relative path accepted")
	}
	if res, _ := estimateDirectories(context.Background(), []BackupArchive{{Name: "t", Path: filepath.Join(root, "nope")}}, nil); res[0].Error == "" {
		t.Error("missing directory not reported")
	}
	if res, _ := estimateDirectories(context.Background(), []BackupArchive{{Name: "t", Path: "/proc"}}, nil); res[0].Error == "" {
		t.Error("virtual file system accepted")
	}
}

func TestNormalizeLexically(t *testing.T) {
	for in, want := range map[string]string{
		"**/.cache": "**/.cache", "./a/../b/": "b/", "/a//b/./c": "/a/b/c", "a/..": "", "/": "/", "!/x": "!/x",
	} {
		if got := normalizeLexically(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}
