package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// Estimate of the size of a directories backup, to check the exclusions before saving a job.
// proxmox-backup-client cannot do it (--dry-run walks nothing), so the agent walks the directories
// itself with the rules of the client, ported from its sources:
//   - patterns: crate pathpatterns (pattern.rs, match_list.rs, a port of git's wildmatch.c), with
//     PatternFlag::PATH_NAME as the client parses them;
//   - walk: pbs-client/src/pxar/create.rs (path matched = "/" + path relative to the archive root,
//     last matching pattern wins, excluded directory not entered, .pxarexclude read in every
//     directory, other file systems and virtual ones not entered).
// Conformance with the real client: golden lists in testdata/estimate, made by pxar (regen.sh).
// The size is the apparent size of the regular files (hard links once): the PBS stores less,
// deduplicated and compressed.

const (
	estimateMaxEntries  = 5_000_000
	estimateTopExcluded = 8
	estimateTimeout     = 3 * time.Minute
)

// EstimateArchive: what one directory would send.
type EstimateArchive struct {
	Name     string       `json:"name"`
	Path     string       `json:"path"`
	Files    int64        `json:"files"`
	Size     int64        `json:"size"`
	Excluded EstimateExcl `json:"excluded"`
	Error    string       `json:"error,omitempty"`
	Partial  bool         `json:"partial,omitempty"` // walk stopped (time or entries): the figures are a minimum
}

// EstimateExcl: what the exclusions remove, with the biggest excluded entries.
type EstimateExcl struct {
	Files int64          `json:"files"`
	Size  int64          `json:"size"`
	Top   []EstimateItem `json:"top"`
}

type EstimateItem struct {
	Path string `json:"path"` // relative to the archive root, with a leading '/'
	Size int64  `json:"size"`
	Dir  bool   `json:"dir,omitempty"`
}

// --- patterns (pathpatterns, PATH_NAME) ------------------------------------------------------

type compKind int

const (
	compLiteral compKind = iota
	compQuestion
	compStar
	compStarStar
	compClass
)

type charClass struct {
	negated bool
	named   []func(byte) bool
	listed  []byte
	ranges  [][2]byte
}

func (c *charClass) matches(ch byte) bool {
	m := bytes.IndexByte(c.listed, ch) >= 0
	for _, r := range c.ranges {
		m = m || (ch >= r[0] && ch <= r[1])
	}
	for _, f := range c.named {
		m = m || f(ch)
	}
	return m != c.negated
}

type component struct {
	kind  compKind
	lit   []byte
	class *charClass
}

func (c component) endsWithSlash() bool {
	return c.kind == compLiteral && len(c.lit) > 0 && c.lit[len(c.lit)-1] == '/'
}

func (c component) startsWithSlash() bool {
	return c.kind == compLiteral && len(c.lit) > 0 && (c.lit[0] == '/' || (c.lit[0] == '\\' && len(c.lit) > 1 && c.lit[1] == '/'))
}

type globPattern struct{ comps []component }

func isASCIIAlpha(b byte) bool { return (b|0x20) >= 'a' && (b|0x20) <= 'z' }
func isASCIIDigit(b byte) bool { return b >= '0' && b <= '9' }

var namedClasses = map[string]func(byte) bool{
	"alnum":  func(b byte) bool { return isASCIIAlpha(b) || isASCIIDigit(b) },
	"alpha":  isASCIIAlpha,
	"blank":  func(b byte) bool { return b == ' ' || b == '\t' },
	"cntrl":  func(b byte) bool { return b < 0x20 || b == 0x7f },
	"digit":  isASCIIDigit,
	"graph":  func(b byte) bool { return b > 0x20 && b < 0x7f },
	"lower":  func(b byte) bool { return b >= 'a' && b <= 'z' },
	"print":  func(b byte) bool { return b >= 0x20 && b <= 0x7f },
	"punct":  func(b byte) bool { return b > 0x20 && b < 0x7f && !isASCIIAlpha(b) && !isASCIIDigit(b) },
	"space":  func(b byte) bool { return b == ' ' || b == '\t' || b == '\n' || b == '\f' || b == '\r' },
	"upper":  func(b byte) bool { return b >= 'A' && b <= 'Z' },
	"xdigit": func(b byte) bool { return isASCIIDigit(b) || ((b|0x20) >= 'a' && (b|0x20) <= 'f') },
}

func parseGlob(p []byte) (*globPattern, error) {
	if len(p) == 0 {
		return nil, errors.New("empty pattern")
	}
	if end := bytes.LastIndexFunc(p, func(r rune) bool { return r != '/' }); end >= 0 {
		p = p[:end+1]
	} else {
		p = []byte("/")
	}
	g := &globPattern{}
	var lit []byte
	flush := func() {
		if len(lit) > 0 {
			g.comps = append(g.comps, component{kind: compLiteral, lit: lit})
			lit = nil
		}
	}
	for i := 0; i < len(p); i++ {
		switch p[i] {
		case 0:
			return nil, errors.New("null-byte in pattern")
		case '\\':
			i++
			if i >= len(p) {
				return nil, errors.New("trailing backslash in pattern")
			}
			lit = append(lit, p[i])
		case '?':
			flush()
			g.comps = append(g.comps, component{kind: compQuestion})
		case '*':
			flush()
			if i+1 < len(p) && p[i+1] == '*' {
				beg := i
				i++
				for i+1 < len(p) && p[i+1] == '*' {
					i++
				}
				if (beg == 0 || p[beg-1] == '/') && (i+1 == len(p) || p[i+1] == '/') {
					g.comps = append(g.comps, component{kind: compStarStar})
				} else {
					g.comps = append(g.comps, component{kind: compStar})
				}
			} else {
				g.comps = append(g.comps, component{kind: compStar})
			}
		case '[':
			flush()
			c, ni, err := parseCharClass(p, i)
			if err != nil {
				return nil, err
			}
			i = ni
			g.comps = append(g.comps, c)
		default:
			lit = append(lit, p[i])
		}
	}
	flush()
	return g, nil
}

// parseCharClass: as pathpatterns, '^' negates ('!' is a listed character), an unclosed class
// is accepted up to the end of the pattern.
func parseCharClass(p []byte, begin int) (component, int, error) {
	i := begin + 1
	c := &charClass{}
	if i < len(p) && p[i] == '^' {
		c.negated = true
		i++
	}
	if i == len(p) {
		return component{}, 0, fmt.Errorf("unclosed character class in pattern, starting at byte %d", begin)
	}
	var prev *byte
	for ; i != len(p); i++ {
		var newPrev *byte
		ch := p[i]
		switch {
		case ch == 0:
			return component{}, 0, errors.New("null-byte in pattern")
		case ch == '[' && i+1 < len(p) && p[i+1] == ':':
			rest := p[i+2:]
			end := bytes.Index(rest, []byte(":]"))
			f, ok := (func(byte) bool)(nil), false
			if end >= 0 {
				f, ok = namedClasses[string(rest[:end])]
			}
			if !ok {
				return component{}, 0, fmt.Errorf("malformed named character class in pattern, starting at byte %d", begin)
			}
			c.named = append(c.named, f)
			i += 2 + end + 1
		case ch == ']':
			return component{kind: compClass, class: c}, i, nil
		case ch == '\\':
			i++
			if i >= len(p) {
				return component{}, 0, errors.New("trailing backslash in pattern")
			}
			c.listed = append(c.listed, p[i])
			v := p[i]
			newPrev = &v
		case ch == '-':
			if prev == nil {
				c.listed = append(c.listed, '-')
				v := byte('-')
				newPrev = &v
			} else {
				beg := *prev
				c.listed = c.listed[:len(c.listed)-1]
				i++
				if i >= len(p) {
					return component{}, 0, fmt.Errorf("unclosed character class in pattern, starting at byte %d", begin)
				}
				end := p[i]
				if end == '\\' {
					i++
					if i >= len(p) {
						return component{}, 0, fmt.Errorf("unclosed character class in pattern, starting at byte %d", begin)
					}
					end = p[i]
				}
				if beg <= end {
					c.ranges = append(c.ranges, [2]byte{beg, end})
				} else {
					c.ranges = append(c.ranges, [2]byte{end, beg})
				}
			}
		default:
			c.listed = append(c.listed, ch)
			v := ch
			newPrev = &v
		}
		prev = newPrev
	}
	return component{kind: compClass, class: c}, i, nil
}

type matchResult int

const (
	mMatch matchResult = iota
	mNoMatch
	mAbortAll
	mAbortToStarStar
)

func (g *globPattern) matches(text []byte) bool { return g.do(0, text, false) == mMatch }

func (g *globPattern) do(ci int, text []byte, skipSlash bool) matchResult {
	comps := g.comps
	for ci != len(comps) {
		skip := skipSlash
		skipSlash = false
		switch c := comps[ci]; c.kind {
		case compLiteral:
			if len(text) == 0 {
				return mAbortAll
			}
			lit := c.lit
			if skip {
				lit = lit[1:]
			}
			if !bytes.HasPrefix(text, lit) {
				return mNoMatch
			}
			text = text[len(lit):]
		case compQuestion:
			if len(text) == 0 {
				return mAbortAll
			}
			if text[0] == '/' {
				return mNoMatch
			}
			text = text[1:]
		case compClass:
			if len(text) == 0 {
				return mAbortAll
			}
			if !c.class.matches(text[0]) {
				return mNoMatch
			}
			text = text[1:]
		case compStar: // PATH_NAME: does not cross '/'
			if ci+1 == len(comps) && bytes.IndexByte(text, '/') < 0 {
				return mMatch
			}
			for {
				if len(text) == 0 {
					return mAbortAll
				}
				switch r := g.do(ci+1, text, false); r {
				case mNoMatch:
					if text[0] == '/' {
						return mAbortToStarStar
					}
				default:
					return r
				}
				text = text[1:]
			}
		case compStarStar:
			if ci+1 == len(comps) {
				return mMatch
			}
			if (ci == 0 || comps[ci-1].endsWithSlash()) && comps[ci+1].startsWithSlash() {
				if g.do(ci+1, text, true) == mMatch {
					return mMatch
				}
			}
			for {
				if len(text) == 0 {
					return mAbortAll
				}
				switch r := g.do(ci+1, text, false); r {
				case mNoMatch, mAbortToStarStar:
				default:
					return r
				}
				text = text[1:]
			}
		}
		ci++
	}
	if len(text) == 0 {
		return mMatch
	}
	return mNoMatch
}

// --- match list (match_list.rs) ----------------------------------------------------------------

type matchEntry struct {
	glob     *globPattern
	include  bool
	dirOnly  bool // trailing '/': MATCH_DIRECTORIES only
	anchored bool // set for the '/…' lines of a .pxarexclude
}

// parseMatchEntry: MatchEntry::parse_pattern(PATH_NAME, Exclude).
func parseMatchEntry(p string) (matchEntry, error) {
	e := matchEntry{}
	b := []byte(p)
	if len(b) > 0 && b[0] == '!' {
		e.include = true
		b = b[1:]
	}
	if end := bytes.LastIndexFunc(b, func(r rune) bool { return r != '/' }); end < 0 {
		b, e.dirOnly = []byte("/"), true
	} else if end+1 != len(b) {
		b, e.dirOnly = b[:end+1], true
	}
	g, err := parseGlob(b)
	if err != nil {
		return e, err
	}
	e.glob = g
	return e, nil
}

func (e *matchEntry) matchesPath(p []byte) bool {
	if e.anchored {
		return e.glob.matches(p)
	}
	if len(p) == 0 {
		return false
	}
	for start := len(p) - 1; start >= 0; start-- {
		if p[start] == '/' && e.glob.matches(p[start+1:]) {
			return true
		}
	}
	return e.glob.matches(p)
}

// matchList: the verdict of the last matching entry (0: none, 1: exclude, 2: include).
func matchList(list []matchEntry, p string, isDir bool) int {
	b := []byte(p)
	for i := len(list) - 1; i >= 0; i-- {
		e := &list[i]
		if e.dirOnly && !isDir {
			continue
		}
		if e.matchesPath(b) {
			if e.include {
				return 2
			}
			return 1
		}
	}
	return 0
}

// normalizeLexically: pbs_client::pxar::tools::normalize_lexically ('.' dropped, '..' pops,
// repeated '/' collapsed, root and trailing '/' kept).
func normalizeLexically(p string) string {
	if p == "" {
		return p
	}
	var parts []string
	for _, c := range strings.Split(p, "/") {
		switch c {
		case "", ".":
		case "..":
			if len(parts) > 0 {
				parts = parts[:len(parts)-1]
			}
		default:
			parts = append(parts, c)
		}
	}
	out := strings.Join(parts, "/")
	if strings.HasPrefix(p, "/") {
		out = "/" + out
	}
	if strings.HasSuffix(p, "/") && out != "/" {
		out += "/"
	}
	return out
}

// compileExcludes: the --exclude patterns of a job, as the client parses them.
func compileExcludes(patterns []string) ([]matchEntry, error) {
	var out []matchEntry
	for _, p := range patterns {
		e, err := parseMatchEntry(normalizeLexically(p))
		if err != nil {
			return nil, fmt.Errorf("exclusion %q : %w", p, err)
		}
		out = append(out, e)
	}
	return out, nil
}

// readPxarExclude: the patterns of the .pxarexclude of a directory (rel: its path relative to the
// root, without leading '/'; "" for the root). Bad lines are ignored, as the client does.
func readPxarExclude(dir, rel string) []matchEntry {
	raw, err := os.ReadFile(filepath.Join(dir, ".pxarexclude"))
	if err != nil {
		return nil
	}
	prefix := ""
	if rel != "" {
		prefix = "/" + rel
	}
	var out []matchEntry
	for _, line := range bytes.Split(raw, []byte{'\n'}) {
		line = bytes.TrimFunc(line, func(r rune) bool { return r < 0x80 && isSpace(byte(r)) })
		if len(line) == 0 || line[0] == '#' {
			continue
		}
		s, include, anchored := string(line), false, false
		switch {
		case line[0] == '/':
			s, anchored = prefix+s, true
		case strings.HasPrefix(s, "!/"):
			s, include, anchored = prefix+s[1:], true, true
		case line[0] == '!':
			s, include = s[1:], true
		}
		e, err := parseMatchEntry(normalizeLexically(s))
		if err != nil {
			continue
		}
		e.include = e.include != include // a '!' left in the pattern inverts again
		e.anchored = anchored
		out = append(out, e)
	}
	return out
}

func isSpace(b byte) bool { return b == ' ' || b == '\t' || b == '\n' || b == '\f' || b == '\r' }

// --- walk (create.rs) --------------------------------------------------------------------------

// virtual file systems the client refuses as a root and does not enter (is_virtual_file_system)
var virtualFS = map[int64]bool{
	0x42494e4d: true, // binfmt
	0x63677270: true, // cgroup2
	0x27e0eb:   true, // cgroup
	0x62656570: true, // configfs
	0x64626720: true, // debugfs
	0x1cd1:     true, // devpts
	0xde5e81e4: true, // efivarfs
	0x65735543: true, // fusectl
	0x958458f6: true, // hugetlbfs
	0x19800202: true, // mqueue
	0x6e667364: true, // nfsd
	0x9fa0:     true, // proc
	0x6165676c: true, // pstore
	0x67596969: true, // rpc_pipefs
	0x73636673: true, // securityfs
	0xf97cff8c: true, // selinux
	0x43415d53: true, // smack
	0x62656572: true, // sysfs
}

func isVirtualFS(dir string) bool {
	var st syscall.Statfs_t
	return syscall.Statfs(dir, &st) == nil && virtualFS[int64(st.Type)]
}

type estimator struct {
	ctx     context.Context
	rootDev uint64
	budget  int
	seen    map[[2]uint64]bool // hard links: counted once
	res     *EstimateArchive
	top     []EstimateItem
	listed  func(rel string) // tests: every archived entry
}

func (e *estimator) stop() bool {
	e.budget--
	if e.budget <= 0 || e.ctx.Err() != nil {
		e.res.Partial = true
		return true
	}
	return false
}

// fileSize: the size a regular file adds (0 for a hard link already counted).
func (e *estimator) fileSize(st *syscall.Stat_t) int64 {
	if st.Nlink > 1 {
		k := [2]uint64{uint64(st.Dev), uint64(st.Ino)}
		if e.seen[k] {
			return 0
		}
		e.seen[k] = true
	}
	return st.Size
}

// walk: the entries of dir (rel: relative path, "" for the root), with the patterns in force.
func (e *estimator) walk(dir, rel string, pats []matchEntry) {
	pats = append(pats[:len(pats):len(pats)], readPxarExclude(dir, rel)...)
	f, err := os.Open(dir)
	if err != nil {
		return
	}
	names, _ := f.Readdirnames(-1)
	f.Close()
	sort.Strings(names)
	for _, name := range names {
		if e.stop() {
			return
		}
		full := filepath.Join(dir, name)
		r := path.Join(rel, name)
		var st syscall.Stat_t
		if syscall.Lstat(full, &st) != nil {
			continue // vanished or denied: skipped by the client too
		}
		isDir := st.Mode&syscall.S_IFMT == syscall.S_IFDIR
		if matchList(pats, "/"+r, isDir) == 1 {
			it := EstimateItem{Path: "/" + r, Dir: isDir}
			if isDir {
				fl, sz := e.total(full)
				e.res.Excluded.Files += fl
				e.res.Excluded.Size += sz
				it.Size = sz
			} else if st.Mode&syscall.S_IFMT == syscall.S_IFREG {
				e.res.Excluded.Files++
				e.res.Excluded.Size += st.Size
				it.Size = st.Size
			}
			if it.Size > 0 {
				e.top = append(e.top, it)
			}
			continue
		}
		if e.listed != nil {
			e.listed("/" + r)
		}
		switch {
		case isDir:
			// another file system (or a virtual one): the directory is archived, not its contents
			if uint64(st.Dev) != e.rootDev {
				continue
			}
			e.walk(full, r, pats)
		case st.Mode&syscall.S_IFMT == syscall.S_IFREG:
			e.res.Files++
			e.res.Size += e.fileSize(&st)
		}
	}
}

// total: files and bytes under an excluded directory (same file system), to show what it removes.
func (e *estimator) total(dir string) (files, size int64) {
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if e.stop() {
			return filepath.SkipAll
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		if st, ok := fi.Sys().(*syscall.Stat_t); ok && d.IsDir() && uint64(st.Dev) != e.rootDev {
			return filepath.SkipDir
		}
		if d.Type().IsRegular() {
			files++
			size += fi.Size()
		}
		return nil
	})
	return
}

func estimateArchive(ctx context.Context, a BackupArchive, pats []matchEntry, budget *int, listed func(string)) EstimateArchive {
	r := EstimateArchive{Name: a.Name, Path: a.Path, Excluded: EstimateExcl{Top: []EstimateItem{}}}
	var st syscall.Stat_t
	if err := syscall.Stat(a.Path, &st); err != nil {
		r.Error = err.Error()
		return r
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		r.Error = "n'est pas un répertoire"
		return r
	}
	if isVirtualFS(a.Path) {
		r.Error = "système de fichiers virtuel : refusé par proxmox-backup-client"
		return r
	}
	e := &estimator{ctx: ctx, rootDev: uint64(st.Dev), budget: *budget, seen: map[[2]uint64]bool{}, res: &r, listed: listed}
	e.walk(a.Path, "", pats)
	*budget = e.budget
	sort.Slice(e.top, func(i, j int) bool { return e.top[i].Size > e.top[j].Size })
	if len(e.top) > estimateTopExcluded {
		e.top = e.top[:estimateTopExcluded]
	}
	if e.top != nil {
		r.Excluded.Top = e.top
	}
	return r
}

// estimateDirectories: the walk of each directory of a job form (validated as a job sent to the agent).
func estimateDirectories(ctx context.Context, archives []BackupArchive, excludes []string) ([]EstimateArchive, error) {
	if len(archives) == 0 || len(archives) > 20 {
		return nil, errors.New("1 to 20 directories expected")
	}
	if err := validateDirectories(archives, excludes); err != nil {
		return nil, err
	}
	pats, err := compileExcludes(excludes)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, estimateTimeout)
	defer cancel()
	budget := estimateMaxEntries
	out := make([]EstimateArchive, 0, len(archives))
	for _, a := range archives {
		out = append(out, estimateArchive(ctx, a, pats, &budget, nil))
	}
	return out, nil
}
