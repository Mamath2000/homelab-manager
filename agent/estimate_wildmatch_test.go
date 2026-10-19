//go:build !windows

package main

import "testing"

// Assertions of the tests of pathpatterns (src/pattern.rs, PATH_NAME, case-sensitive), ported as
// they are: the matcher of the estimate must give the same answers as the one of the PBS client.
var wildmatchCases = []struct {
	pattern, text string
	match         bool
}{
	{"/hey/*/you", "/hey/asdf/you", true},
	{"/hey/*/you", "/hey/asdf/more/you", false},
	{"/hey/*/you", "/heyasdf/you", false},
	{"/hey/*/you", "/heyasdfyou", false},
	{"/hey/*/you", "/hey/asdfyou", false},
	{"/hey/*/you", "/hey/you", false},
	{"/hey/*/you", "/hey//you", true},
	{"/hey/**/you", "/hey/asdf/you", true},
	{"/hey/**/you", "/hey/asdf/more/you", true},
	{"/hey/**/you", "/heyasdf/you", false},
	{"/hey/**/you", "/heyasdfyou", false},
	{"/hey/**/you", "/hey/asdfyou", false},
	{"/hey/**/you", "/hey/you", true},
	{"/hey/**/you", "/hey//you", true},
	{"/he[yx]/**/you", "/hey/asdf/you", true},
	{"/he[yx]/**/you", "/hey/asdf/more/you", true},
	{"/he[yx]/**/you", "/heyasdf/you", false},
	{"/he[yx]/**/you", "/heyasdfyou", false},
	{"/he[yx]/**/you", "/hey/asdfyou", false},
	{"/he[yx]/**/you", "/hey/you", true},
	{"/he[yx]/**/you", "/hey//you", true},
	{"/he[yx]/**/you", "/hex/asdf/you", true},
	{"/he[yx]/**/you", "/hex/asdf/more/you", true},
	{"/he[yx]/**/you", "/hexasdf/you", false},
	{"/he[yx]/**/you", "/hexasdfyou", false},
	{"/he[yx]/**/you", "/hex/asdfyou", false},
	{"/he[yx]/**/you", "/hex/you", true},
	{"/he[yx]/**/you", "/hex//you", true},
	{"/he[yx]/**/you", "/hez/asdf/you", false},
	{"/he[yx]/**/you", "/hez/asdf/more/you", false},
	{"/he[yx]/**/you", "/hezasdf/you", false},
	{"/he[yx]/**/you", "/hezasdfyou", false},
	{"/he[yx]/**/you", "/hez/asdfyou", false},
	{"/he[yx]/**/you", "/hez/you", false},
	{"/he[yx]/**/you", "/hez//you", false},
	{"/he[^yx]/**/you", "/hey/asdf/you", false},
	{"/he[^yx]/**/you", "/hey/asdf/more/you", false},
	{"/he[^yx]/**/you", "/heyasdf/you", false},
	{"/he[^yx]/**/you", "/heyasdfyou", false},
	{"/he[^yx]/**/you", "/hey/asdfyou", false},
	{"/he[^yx]/**/you", "/hey/you", false},
	{"/he[^yx]/**/you", "/hey//you", false},
	{"/he[^yx]/**/you", "/hex/asdf/you", false},
	{"/he[^yx]/**/you", "/hex/asdf/more/you", false},
	{"/he[^yx]/**/you", "/hexasdf/you", false},
	{"/he[^yx]/**/you", "/hexasdfyou", false},
	{"/he[^yx]/**/you", "/hex/asdfyou", false},
	{"/he[^yx]/**/you", "/hex/you", false},
	{"/he[^yx]/**/you", "/hex//you", false},
	{"/he[^yx]/**/you", "/hez/asdf/you", true},
	{"/he[^yx]/**/you", "/hez/asdf/more/you", true},
	{"/he[^yx]/**/you", "/hezasdf/you", false},
	{"/he[^yx]/**/you", "/hezasdfyou", false},
	{"/he[^yx]/**/you", "/hez/asdfyou", false},
	{"/he[^yx]/**/you", "/hez/you", true},
	{"/he[^yx]/**/you", "/hez//you", true},
	{"/tes[a-t]", "/testoolong", false},
	{"/tes[a-t]", "/tes", false},
	{"/tes[a-t]", "/t", false},
	{"/tes[a-t]", "/", false},
	{"/tes[a-t]", "", false},
	{"/tes[a-t]", "/tesa", true},
	{"/tes[a-t]", "/test", true},
	{"/tes[a-t]", "/tesu", false},
	{"/tes[a-t]/a?a", "/tesu", false},
	{"/tes[a-t]/a?a", "/tesu/aaa", false},
	{"/tes[a-t]/a?a", "/tesu/xax", false},
	{"/tes[a-t]/a?a", "/test/xax", false},
	{"/tes[a-t]/a?a", "/test/a", false},
	{"/tes[a-t]/a?a", "/test/ab", false},
	{"/tes[a-t]/a?a", "/test/aba", true},
	{"/tes[a-t]/a?a", "/test/aaa", true},
	{"/tes[a-t]/a?a", "/test/aba", true},
	{"/tes[a-t]/a?a", "/test/a/a", false},
	{"a*b*c", "axxbxxc", true},
	{"a*b*c", "axxbxxcxx", false},
	{"a*b*c", "axxbxxbxxc", true},
	{"a*b*c", "axxbxxbxxcxx", false},
	{"a*b*c", "axxbxxbxxcxxc", true},
	{"a*b*c", "axxbxxbxxcxxcxx", false},
	{"a*b*c*", "axxbxxc", true},
	{"a*b*c*", "axxbxxcxx", true},
	{"a*b*c*", "axxbxxbxxc", true},
	{"a*b*c*", "axxbxxbxxcxx", true},
	{"a*b*c*", "axxbxxbxxcxxc", true},
	{"a*b*c*", "axxbxxbxxcxxcxx", true},
	{"a/b**/c", "a/bxx/c", true},
	{"a/b**/c", "a/bxx/yy/c", false},
	{"**/lost+found", "/foo/lost+found", true},
	{"**/lost+found", "foo/lost+found", true},
	{"**/lost+found", "/lost+found", true},
	{"**/lost+found", "///lost+found", true},
	{"**/lost+found", "lost+found", true},
	{"**/lost+found", "lost+found2", false},
	{"**/lost+found", "lost+found/", false},
	{"**/lost+found", "xlost+found", false},
	{"**/lost+found", "xlost+found/", false},
}

func TestWildmatchPathpatterns(t *testing.T) {
	for _, c := range wildmatchCases {
		g, err := parseGlob([]byte(c.pattern))
		if err != nil {
			t.Fatalf("%q: %v", c.pattern, err)
		}
		if got := g.matches([]byte(c.text)); got != c.match {
			t.Errorf("%q ~ %q: got %v, want %v", c.pattern, c.text, got, c.match)
		}
	}
}
