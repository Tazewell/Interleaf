package interleaf

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

var errBabelDOCUntranslated = errors.New("BabelDOC output retained most of the original prose")

const babeldocContentSamplePages = 19

func checkBabelDOCReadingContent(ctx context.Context, work string, original, translated []byte, totalPages int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if totalPages < 1 || os.Getenv("INTERLEAF_NODE") == "" ||
		(os.Getenv("INTERLEAF_CORPUS_PROCESSOR") == "" && os.Getenv("INTERLEAF_PROCESSOR") == "") {
		return nil
	}
	check, err := os.MkdirTemp(work, "content-check-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(check)

	checkCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	pages := babeldocContentPages(totalPages)
	args := strings.Join(pages, ",")
	extract := func(name string, pdf []byte) (extractedPDF, error) {
		dir := filepath.Join(check, name)
		if err := os.Mkdir(dir, 0700); err != nil {
			return extractedPDF{}, err
		}
		input := filepath.Join(dir, "input.pdf")
		if err := os.WriteFile(input, pdf, 0600); err != nil {
			return extractedPDF{}, err
		}
		return runPDFTextWorker(checkCtx, dir, input, args)
	}
	// Text extraction can be unavailable for some otherwise readable PDFs.
	source, err := extract("original", original)
	if err != nil || source.TotalPages != totalPages || len(source.Pages) != len(pages) {
		return ctx.Err()
	}
	target, err := extract("translated", translated)
	if err != nil || target.TotalPages != totalPages || len(target.Pages) != len(pages) {
		return ctx.Err()
	}
	untranslated := babeldocMostlyUntranslated(source, target)
	if err := ctx.Err(); err != nil {
		return err
	}
	if untranslated {
		return errBabelDOCUntranslated
	}
	return nil
}

func babeldocContentPages(total int) []string {
	count := min(total, babeldocContentSamplePages)
	pages := make([]string, count)
	for i := range pages {
		pages[i] = strconv.Itoa(1 + i*(total-1)/max(1, count-1))
	}
	return pages
}

func babeldocMostlyUntranslated(original, translated extractedPDF) bool {
	target := make(map[int]babeldocContentPage, len(translated.Pages))
	for _, page := range translated.Pages {
		var text babeldocContentPage
		for _, span := range page.Spans {
			text.add(span.Text)
		}
		target[page.Page] = text
	}
	eligible, unchanged, addedHan := 0, 0, 0
	for _, page := range original.Pages {
		output, ok := target[page.Page]
		if !ok {
			continue
		}
		var source babeldocContentPage
		for _, span := range page.Spans {
			source.add(span.Text)
		}
		addedHan += max(0, output.han-source.han)
		// A page of names, short labels, formulae, or mostly non-Latin text
		// provides too little evidence for a copied-prose decision.
		if source.words < 60 || len(source.tokens) < 30 || source.latin < 2*source.other {
			continue
		}
		eligible++
		matched := 0
		for word, count := range source.tokens {
			matched += min(count, output.tokens[word])
		}
		if matched*100 >= 85*source.words {
			unchanged++
		}
	}
	// Retained terms and references are expected. Reject only when almost all
	// source words survive on most sampled pages with very little new Chinese.
	return eligible > 0 && unchanged*3 >= eligible*2 && addedHan < 30*eligible
}

type babeldocContentPage struct {
	tokens                   map[string]int
	words, latin, other, han int
}

var babeldocContentLatinWord = regexp.MustCompile(`\p{Latin}{3,}`)

func (p *babeldocContentPage) add(text string) {
	for _, r := range text {
		switch {
		case unicode.Is(unicode.Latin, r):
			p.latin++
		case unicode.Is(unicode.Han, r):
			p.han++
			p.other++
		case unicode.IsLetter(r):
			p.other++
		}
	}
	for _, word := range babeldocContentLatinWord.FindAllString(strings.ToLower(text), -1) {
		if p.tokens == nil {
			p.tokens = make(map[string]int)
		}
		p.tokens[word]++
		p.words++
	}
}
