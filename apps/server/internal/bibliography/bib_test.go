package bibliography

import (
	"fmt"
	"strings"
	"testing"
)

func TestBibPreservesExpressionsAndResolvesMacros(t *testing.T) {
	input := `@string{conf = "International " # {Conference}}
@preamble{"\\providecommand{\\noop}[1]{}"}
@proceedings{parent, title = conf, year = 2025}
@inproceedings{Wang2025,
 title = {A {GPU} Study: 中文与 {\LaTeX}},
 author = {Wang, Wei and {World Health Organization}},
 booktitle = conf # { on Systems},
 crossref = {parent},
 custom = "Keep {\"a} and {Nested {Braces}}",
 month = jan,
}`
	db, err := Parse(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(db.Entries) != 2 || db.Entries[1].Key != "Wang2025" {
		t.Fatalf("entries: %+v", db.Entries)
	}
	for field, want := range map[string]string{
		"title":     `A {GPU} Study: 中文与 {\LaTeX}`,
		"author":    "Wang, Wei and {World Health Organization}",
		"booktitle": "International Conference on Systems",
		"crossref":  "parent", "month": "January",
	} {
		got, e := db.Value(db.Entries[1], field)
		if e != nil || got != want {
			t.Fatalf("%s: %q, %v, want %q", field, got, e, want)
		}
	}
	text, err := Render(db)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, `conf # { on Systems}`) || !strings.Contains(text, `custom = "Keep {\"a} and {Nested {Braces}}"`) {
		t.Fatalf("expressions lost: %s", text)
	}
	if !strings.Contains(text, `@preamble{"\\providecommand{\\noop}[1]{}"}`) {
		t.Fatalf("preamble lost: %s", text)
	}
	copy, err := Parse(text)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := copy.Value(copy.Entries[1], "booktitle")
	if got != "International Conference on Systems" {
		t.Fatal(got)
	}
}

func TestBibRejectsBrokenInputWithLocation(t *testing.T) {
	for _, text := range []string{
		"@article{key,\n title = {unfinished}",
		`@article{key,title="unfinished}`,
		`@article{key,title={one} # }`,
		`@article{key title={one}}`,
		`@string{x = y} @string{y = x} @article{k,title=x}`,
		`@article{k,title={one},title={two}}`,
		"@article{k,title={" + strings.Repeat("{", 150) + "x" + strings.Repeat("}", 150) + "}}",
	} {
		_, err := Parse(text)
		if err == nil {
			t.Fatalf("accepted malformed input: %s", text)
		}
		if !strings.Contains(err.Error(), "行") {
			t.Fatalf("missing error location: %v", err)
		}
	}
}

func TestBibHandlesParenthesesCommentsAndEscapedQuotes(t *testing.T) {
	db, err := Parse("% heading\n@comment{ignored {nested}}\n@article(key, title = \"Say \\\"hi\\\"\", year=2024)")
	if err != nil {
		t.Fatal(err)
	}
	title, err := db.Value(db.Entries[0], "title")
	if err != nil || title != `Say \"hi\"` {
		t.Fatalf("title=%q err=%v", title, err)
	}
}

func TestBibUndefinedMacroIsAnExplicitError(t *testing.T) {
	db, err := Parse(`@article{k,title=unknownMacro}`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Value(db.Entries[0], "title"); err == nil {
		t.Fatal("undefined macro silently discarded")
	}
}

func TestBibRejectsExponentialMacroExpansion(t *testing.T) {
	// A tiny input must not cause hundreds of thousands of recursive expansions.
	var text strings.Builder
	text.WriteString("@string{a0={x}}\n")
	for i := 1; i <= 12; i++ {
		fmt.Fprintf(&text, "@string{a%d=a%d # a%d # a%d}\n", i, i-1, i-1, i-1)
	}
	if _, err := Parse(text.String()); err == nil {
		t.Fatal("accepted unbounded macro expansion")
	}
}
