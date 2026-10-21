package reader

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"reader.local/server/internal/bibliography"
)

func paperBibCall(t *testing.T, s *Server, path string, v any, status int) []byte {
	t.Helper()
	b, _ := json.Marshal(v)
	w := request(t, s, "POST", "/api/papers/bibliography/"+path, strings.NewReader(string(b)))
	if w.Code != status {
		t.Fatalf("%s: %d %s (want %d)", path, w.Code, w.Body.String(), status)
	}
	return w.Body.Bytes()
}
func paperBibImport(t *testing.T, s *Server, text string, decisions []map[string]any) []PaperItem {
	t.Helper()
	b := paperBibCall(t, s, "import", map[string]any{"text": text, "decisions": decisions}, 200)
	var p []PaperItem
	if err := json.Unmarshal(b, &p); err != nil {
		t.Fatal(err)
	}
	return p
}
func paperBibExport(t *testing.T, s *Server, ids []string, mode string) string {
	t.Helper()
	b := paperBibCall(t, s, "export", map[string]any{"ids": ids, "mode": mode}, 200)
	var v struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v.Text
}

func TestPaperBibRoundTripSubsetAndRenamedParent(t *testing.T) {
	s := testServer(t)
	const src = `@string{conf="International " # {Conference}}
@preamble{"\providecommand{\noop}[1]{}"}
@proceedings{Parent,title=conf,year=2025,publisher={Publisher}}
@inproceedings{Child,title={A {GPU} Study with {\LaTeX}},author={Wang, Wei and {World Health Organization}},booktitle=conf # { on Systems},crossref={Parent},unknown="Keep {\"a} and {Nested {Braces}}"}`
	preview := paperBibCall(t, s, "preview", map[string]any{"text": src}, 200)
	if !strings.Contains(string(preview), "Child") || !strings.Contains(string(preview), "unknown") {
		t.Fatal(string(preview))
	}
	papers := paperBibImport(t, s, src, []map[string]any{{"index": 0, "action": "create"}, {"index": 1, "action": "create"}})
	if len(papers) != 2 || papers[0].CitationKey != "Parent" || papers[1].CitationKey != "Child" || len(papers[1].Attachments) != 0 {
		t.Fatal(papers)
	}
	out := paperBibExport(t, s, []string{papers[1].ID}, "bibtex")
	for _, want := range []string{`@proceedings{Parent`, `@inproceedings{Child`, `conf # { on Systems}`, `unknown = "Keep {\"a} and {Nested {Braces}}"`, `@preamble{"\providecommand{\noop}[1]{}"}`} {
		if !strings.Contains(out, want) {
			t.Fatalf("lost %q: %s", want, out)
		}
	}
	paperCall(t, s, "PATCH", "/api/papers/"+papers[0].ID, `{"citationKey":"Renamed"}`, 200)
	out = paperBibExport(t, s, []string{papers[1].ID}, "biblatex")
	db, err := bibliography.Parse(out)
	if err != nil {
		t.Fatal(err)
	}
	child := db.Entries[0]
	for _, e := range db.Entries {
		if e.Key == "Child" {
			child = e
		}
	}
	ref, err := db.Value(child, "crossref")
	if err != nil || ref != "Renamed" || !strings.Contains(out, "@proceedings{Renamed") {
		t.Fatalf("%s %v", out, err)
	}
	if _, err = s.Store.DB.Exec(`DELETE FROM paper_items WHERE id=?`, papers[0].ID); err != nil {
		t.Fatal(err)
	}
	paperBibCall(t, s, "export", map[string]any{"ids": []string{papers[1].ID}, "mode": "bibtex"}, 409)
}

func TestPaperBibManualMergeAndTransactionalConflicts(t *testing.T) {
	s := testServer(t)
	target := paperCreate(t, s, "Manual title & safe {text}")
	paperCall(t, s, "PATCH", "/api/papers/"+target, `{"citationKey":"Existing","metadata":{"doi":"10.1234/match","venue":"Manual venue","date":"2026"}}`, 200)
	src := `@article{Imported,title={Incoming},doi={10.1234/match},journal={Incoming venue},year=2020,custom={Keep}}`
	preview := paperBibCall(t, s, "preview", map[string]any{"text": src}, 200)
	if !strings.Contains(string(preview), target) {
		t.Fatal(string(preview))
	}
	p := paperBibImport(t, s, src, []map[string]any{{"index": 0, "action": "merge", "paperId": target}})
	if p[0].Title != "Manual title & safe {text}" || p[0].CitationKey != "Existing" || p[0].Metadata.Venue != "Manual venue" || p[0].Metadata.Date != "2026" {
		t.Fatal(p)
	}
	out := paperBibExport(t, s, []string{target}, "bibtex")
	if !strings.Contains(out, `title = {Manual title \& safe \{text\}}`) || !strings.Contains(out, `custom = {Keep}`) || strings.Contains(out, "Incoming venue") {
		t.Fatal(out)
	}
	before := len(paperList(t, s))
	for _, decisions := range [][]map[string]any{
		{{"index": 0, "action": "create"}, {"index": 1, "action": "create"}},
		{{"index": 0, "action": "create"}},
		{{"index": 0, "action": "create"}, {"index": 0, "action": "skip"}},
	} {
		body := map[string]any{"text": `@article{New,title={New}} @article{Existing,title={Collision}}`, "decisions": decisions}
		b, _ := json.Marshal(body)
		w := request(t, s, "POST", "/api/papers/bibliography/import", strings.NewReader(string(b)))
		if w.Code < 400 {
			t.Fatal(w.Body.String())
		}
		if len(paperList(t, s)) != before {
			t.Fatal("partial import committed")
		}
	}
	paperBibCall(t, s, "import", map[string]any{"text": src, "decisions": []map[string]any{{"index": 0, "action": "merge", "paperId": target, "citationKey": "Imported"}}}, 409)
	paperBibCall(t, s, "import", map[string]any{"text": src, "decisions": []map[string]any{{"index": 0, "action": "merge", "paperId": target, "citationKey": "Imported"}}, "confirmCitationChange": true}, 200)
}

func TestPaperBibDependenciesAndMacroContexts(t *testing.T) {
	s := testServer(t)
	for _, src := range []string{`@article{a,title={A},crossref={missing}}`, `@book{a,title={A},crossref={b}} @book{b,title={B},crossref={a}}`, `@article{a,title=missingMacro}`} {
		var db bibliography.Database
		db, _ = bibliography.Parse(src)
		d := []map[string]any{}
		for i := range db.Entries {
			d = append(d, map[string]any{"index": i, "action": "create"})
		}
		b, _ := json.Marshal(map[string]any{"text": src, "decisions": d})
		w := request(t, s, "POST", "/api/papers/bibliography/import", strings.NewReader(string(b)))
		if w.Code < 400 {
			t.Fatalf("accepted bad dependency %s", src)
		}
		if len(paperList(t, s)) != 0 {
			t.Fatal("dependency failure committed")
		}
	}
	a := paperBibImport(t, s, `@string{venue={First}} @article{a,title={A},journal=venue}`, []map[string]any{{"index": 0, "action": "create"}})[0]
	b := paperBibImport(t, s, `@string{venue={Second}} @article{b,title={B},journal=venue}`, []map[string]any{{"index": 0, "action": "create"}})[0]
	// Conflicting macro contexts must be an explicit error, never silently use one definition.
	paperBibCall(t, s, "export", map[string]any{"ids": []string{a.ID, b.ID}, "mode": "bibtex"}, 409)
	for _, p := range []PaperItem{a, b} {
		out := paperBibExport(t, s, []string{p.ID}, "bibtex")
		db, err := bibliography.Parse(out)
		if err != nil {
			t.Fatal(err)
		}
		venue, err := db.Value(db.Entries[0], "journal")
		if err != nil || venue != p.Metadata.Venue {
			t.Fatalf("%s %v", out, err)
		}
	}
}

func TestPaperBibManagedEmptyAndManualAuthor(t *testing.T) {
	s := testServer(t)
	text, err := s.Store.Bibliography(nil, "bibtex")
	if err != nil || text != "" {
		t.Fatalf("empty managed bibliography: %q %v", text, err)
	}
	p := paperBibImport(t, s, `@article{k,title={T},author={Old, Author},year=2025}`, []map[string]any{{"index": 0, "action": "create"}})[0]
	paperCall(t, s, "PATCH", "/api/papers/"+p.ID, `{"author":"Manual Author"}`, 200)
	text = paperBibExport(t, s, []string{p.ID}, "bibtex")
	if !strings.Contains(text, `author = {Manual Author}`) {
		t.Fatal(text)
	}
}

func TestPaperBibItemMergePreservesExpressionsAndDependencies(t *testing.T) {
	s := testServer(t)
	p := paperBibImport(t, s, `@book{p,title={Parent}} @article{c,title={Child},crossref={p}}`, []map[string]any{{"index": 0, "action": "create"}, {"index": 1, "action": "create"}})
	target := paperCreate(t, s, "Target")
	paperCall(t, s, "POST", "/api/papers/"+target+"/merge", `{"ids":["`+p[0].ID+`"]}`, 200)
	text := paperBibExport(t, s, []string{p[1].ID}, "bibtex")
	if strings.Index(text, "@article{c") > strings.Index(text, "@book{p") {
		t.Fatal("parent must follow child: " + text)
	}
	source := paperBibImport(t, s, `@article{raw,title={Protected {GPU} with {\LaTeX}},custom={Unknown {Nested}},year=2024}`, []map[string]any{{"index": 0, "action": "create"}})[0]
	target2 := paperCreate(t, s, "Manual")
	paperCall(t, s, "POST", "/api/papers/"+target2+"/merge", `{"ids":["`+source.ID+`"]}`, 200)
	text = paperBibExport(t, s, []string{target2}, "bibtex")
	if !strings.Contains(text, `custom = {Unknown {Nested}}`) {
		t.Fatal(text)
	}
	a := paperBibImport(t, s, `@string{x={One}} @article{a,title={A},journal=x}`, []map[string]any{{"index": 0, "action": "create"}})[0]
	b := paperBibImport(t, s, `@string{x={Two}} @article{b,title={B},journal=x}`, []map[string]any{{"index": 0, "action": "create"}})[0]
	paperCall(t, s, "POST", "/api/papers/"+a.ID+"/merge", `{"ids":["`+b.ID+`"],"citationKey":"a","confirmCitationChange":true}`, 409)
	if _, err := s.Store.PaperItem(b.ID); err != nil {
		t.Fatal("merge failed to roll back", err)
	}
}

func TestPaperBibInvalidPreambleAndPreviewSyntax(t *testing.T) {
	s := testServer(t)
	preview := paperBibCall(t, s, "preview", map[string]any{"text": "@article{k,title={unfinished}"}, 200)
	if !strings.Contains(string(preview), "errors") || !strings.Contains(string(preview), "行") {
		t.Fatal(string(preview))
	}
	paperBibCall(t, s, "import", map[string]any{"text": `@preamble{undefinedMacro} @article{k,title={T}}`, "decisions": []map[string]any{{"index": 0, "action": "create"}}}, 400)
	if len(paperList(t, s)) != 0 {
		t.Fatal("invalid preamble committed")
	}
}

func TestPaperBibReimportAfterParentRename(t *testing.T) {
	s := testServer(t)
	src := `@proceedings{Parent,title={Proceedings}} @inproceedings{Child,title={T},crossref={Parent}}`
	p := paperBibImport(t, s, src, []map[string]any{{"index": 0, "action": "create"}, {"index": 1, "action": "create"}})
	paperCall(t, s, "PATCH", "/api/papers/"+p[0].ID, `{"citationKey":"Renamed"}`, 200)
	paperBibImport(t, s, `@inproceedings{Child,title={T updated},custom={Keep}}`, []map[string]any{{"index": 0, "action": "merge", "paperId": p[1].ID}})
	text := paperBibExport(t, s, []string{p[1].ID}, "bibtex")
	if !strings.Contains(text, "crossref = {Renamed}") {
		t.Fatal(text)
	}
}

func TestPaperBibActualTeXCompilation(t *testing.T) {
	for _, tool := range []string{"pdflatex", "bibtex", "biber"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("actual compilation unavailable: %s: %v", tool, err)
		}
	}
	s := testServer(t)
	p := paperBibImport(t, s, `@string{venue=prefix # { of Testing}} @string{prefix={Journal}} @article{Garcia2025,title={A {GPU} Study with {\LaTeX}},author={Garc{\'i}a, Ana and {World Health Organization}},journal=venue,year=2025,volume=1,pages={1--10},custom={Untouched}}`, []map[string]any{{"index": 0, "action": "create"}})
	for _, mode := range []string{"bibtex", "biblatex"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			text := paperBibExport(t, s, []string{p[0].ID}, mode)
			if err := os.WriteFile(filepath.Join(dir, "library.bib"), []byte(text), 0600); err != nil {
				t.Fatal(err)
			}
			tex := `\documentclass{article}
\begin{document}
\nocite{Garcia2025}
\bibliographystyle{plain}
\bibliography{library}
\end{document}`
			if mode == "biblatex" {
				tex = `\documentclass{article}
\usepackage[backend=biber,style=numeric]{biblatex}
\addbibresource{library.bib}
\begin{document}
\nocite{Garcia2025}
\printbibliography
\end{document}`
			}
			if err := os.WriteFile(filepath.Join(dir, "main.tex"), []byte(tex), 0600); err != nil {
				t.Fatal(err)
			}
			run := func(tool string, args ...string) {
				t.Helper()
				ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
				defer cancel()
				cmd := exec.CommandContext(ctx, tool, args...)
				cmd.Dir = dir
				out, err := cmd.CombinedOutput()
				if err != nil {
					t.Fatalf("%s: %v\n%s", tool, err, out)
				}
			}
			latex := func() { run("pdflatex", "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "main.tex") }
			latex()
			if mode == "biblatex" {
				run("biber", "main")
			} else {
				run("bibtex", "main")
			}
			latex()
			latex()
			for _, name := range []string{"main.pdf", "main.bbl"} {
				info, err := os.Stat(filepath.Join(dir, name))
				if err != nil || info.Size() == 0 {
					t.Fatalf("%s missing: %v", name, err)
				}
			}
			log, err := os.ReadFile(filepath.Join(dir, "main.log"))
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(log), "undefined references") || strings.Contains(string(log), "Citation `Garcia2025' on page 1 undefined") {
				t.Fatal(string(log))
			}
		})
	}
}

func TestPaperBibStableSnapshotsAndPlainDate(t *testing.T) {
	s := testServer(t)
	z, a := paperCreate(t, s, "Zulu"), paperCreate(t, s, "Alpha")
	first := paperBibExport(t, s, []string{z, a}, "bibtex")
	second := paperBibExport(t, s, []string{a, z}, "bibtex")
	if first != second {
		t.Fatalf("snapshot changed with selection order:\n%s\n%s", first, second)
	}
	p := paperBibImport(t, s, `@article{k,title={T},year=2025}`, []map[string]any{{"index": 0, "action": "create"}})[0]
	raw := paperBibExport(t, s, []string{p.ID}, "bibtex")
	if strings.Contains(raw, "author =") {
		t.Fatal("untouched absent author was synthesized: " + raw)
	}
	paperCall(t, s, "PATCH", "/api/papers/"+p.ID, `{"metadata":{"date":"2025-05-17"}}`, 200)
	text := paperBibExport(t, s, []string{p.ID}, "bibtex")
	for _, want := range []string{`year = {2025}`, `month = {May}`, `day = {17}`} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing date component %q: %s", want, text)
		}
	}
	text = paperBibExport(t, s, []string{p.ID}, "biblatex")
	if !strings.Contains(text, `date = {2025-05-17}`) {
		t.Fatal(text)
	}
}
