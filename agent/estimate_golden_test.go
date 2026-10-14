package main

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// Conformance with proxmox-backup-client: the walk of the estimate must archive exactly the
// entries pxar archives for the same tree and exclusions (testdata/estimate, golden lists made
// by the real client with regen.sh).

func buildFixtureTree(t *testing.T, root string) {
	t.Helper()
	f, err := os.Open("testdata/estimate/tree.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		kind, rest, _ := strings.Cut(line, " ")
		switch kind {
		case "f":
			writeTree(t, root, map[string]string{rest: rest})
		case "d":
			if err := os.MkdirAll(filepath.Join(root, rest), 0o755); err != nil {
				t.Fatal(err)
			}
		case "x":
			p, content, _ := strings.Cut(rest, " ")
			// printf %b of regen.sh: only \n is used
			writeTree(t, root, map[string]string{p: strings.ReplaceAll(content, `\n`, "\n")})
		}
	}
}

func TestEstimateGolden(t *testing.T) {
	root := t.TempDir()
	buildFixtureTree(t, root)
	raw, err := os.ReadFile("testdata/estimate/cases.txt")
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, line := range strings.Split(string(raw), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Split(line, "\t")
		name, excludes := fields[0], fields[1:]
		want, err := os.ReadFile(filepath.Join("testdata/estimate/golden", name+".txt"))
		if err != nil {
			t.Fatalf("%s: %v (run testdata/estimate/regen.sh)", name, err)
		}
		pats, err := compileExcludes(excludes)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var got []string
		budget := estimateMaxEntries
		estimateArchive(context.Background(), BackupArchive{Name: "t", Path: root}, pats, &budget, func(p string) { got = append(got, p) })
		sort.Strings(got)
		g := strings.Join(got, "\n")
		if len(got) > 0 {
			g += "\n"
		}
		if g != string(want) {
			t.Errorf("case %s (%s): differs from pxar\n%s", name, strconv.Quote(strings.Join(excludes, " ")), diffLines(string(want), g))
		}
		n++
	}
	if n < 20 {
		t.Fatalf("only %d cases", n)
	}
}

func diffLines(want, got string) string {
	w, g := map[string]bool{}, map[string]bool{}
	for _, l := range strings.Split(want, "\n") {
		w[l] = true
	}
	for _, l := range strings.Split(got, "\n") {
		g[l] = true
	}
	var out []string
	for l := range w {
		if !g[l] {
			out = append(out, "  only pxar: "+l)
		}
	}
	for l := range g {
		if !w[l] {
			out = append(out, "  only estimate: "+l)
		}
	}
	sort.Strings(out)
	return strings.Join(out, "\n")
}
