package interleaf

import (
	"fmt"
	"slices"
	"strconv"
	"strings"

	"interleaf.local/server/internal/bibliography"
)

var bibMetadataFields = []struct{ Bib, Meta string }{
	{"date", "date"}, {"journal", "venue"}, {"journaltitle", "venue"}, {"booktitle", "venue"},
	{"volume", "volume"}, {"number", "issue"}, {"pages", "pages"}, {"publisher", "publisher"},
	{"doi", "doi"}, {"eprint", "arxiv"}, {"isbn", "isbn"}, {"url", "url"}, {"abstract", "abstract"}, {"language", "language"},
}

func bibItemType(kind string) string {
	switch kind {
	case "article":
		return "journal"
	case "inproceedings", "conference", "proceedings":
		return "conference"
	case "book", "mvbook":
		return "book"
	case "inbook", "incollection":
		return "chapter"
	case "phdthesis", "mastersthesis", "thesis":
		return "thesis"
	case "techreport", "report":
		return "report"
	case "unpublished", "online":
		return "preprint"
	default:
		return "other"
	}
}
func bibKind(kind, mode string) string {
	switch kind {
	case "journal":
		return "article"
	case "conference":
		return "inproceedings"
	case "book":
		return "book"
	case "chapter":
		return "incollection"
	case "thesis":
		if mode == "biblatex" {
			return "thesis"
		}
		return "phdthesis"
	case "report":
		if mode == "biblatex" {
			return "report"
		}
		return "techreport"
	case "preprint":
		if mode == "biblatex" {
			return "online"
		}
		return "unpublished"
	default:
		return "misc"
	}
}

// Split only at the outer level: an institution enclosed in braces is one name.
func bibSplit(s, sep string) []string {
	out := []string{}
	start, depth := 0, 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' {
			i++
			continue
		}
		if s[i] == '{' {
			depth++
		}
		if s[i] == '}' {
			depth--
		}
		if depth == 0 && strings.HasPrefix(s[i:], sep) {
			out = append(out, strings.TrimSpace(s[start:i]))
			i += len(sep) - 1
			start = i + 1
		}
	}
	return append(out, strings.TrimSpace(s[start:]))
}
func bibCreators(author string) []Creator {
	out := []Creator{}
	if author == "" {
		return out
	}
	for _, name := range bibSplit(author, " and ") {
		if strings.HasPrefix(name, "{") && strings.HasSuffix(name, "}") {
			out = append(out, Creator{Name: name[1 : len(name)-1]})
			continue
		}
		parts := bibSplit(name, ",")
		if len(parts) >= 2 {
			out = append(out, Creator{Family: parts[0], Given: strings.Join(parts[1:], ", ")})
			continue
		}
		words := strings.Fields(name)
		if len(words) > 1 {
			out = append(out, Creator{Family: words[len(words)-1], Given: strings.Join(words[:len(words)-1], " ")})
		} else if name != "" {
			out = append(out, Creator{Name: name})
		}
	}
	return out
}

func bibMapped(db bibliography.Database, e bibliography.Entry) (PaperItem, error) {
	p := PaperItem{Metadata: PaperMetadata{Sources: map[string]string{}}}
	// Resolve every expression, including unknown fields, before accepting data.
	for _, f := range e.Fields {
		if _, err := db.Value(e, f.Name); err != nil {
			return p, fmt.Errorf("%s / %s：%w", e.Key, f.Name, err)
		}
	}
	p.Title, _ = db.Value(e, "title")
	if p.Title == "" {
		p.Title = e.Key
	}
	p.Metadata.Sources["title"] = "bibtex"
	p.Metadata.ItemType = bibItemType(e.Type)
	p.Metadata.Sources["itemType"] = "bibtex"
	author, _ := db.Value(e, "author")
	p.Metadata.Creators = bibCreators(author)
	p.Author = CreatorNames(p.Metadata.Creators)
	if author != "" {
		p.Metadata.Sources["creators"] = "bibtex"
	}
	for _, f := range bibMetadataFields {
		if f.Meta == "arxiv" {
			archive, _ := db.Value(e, "eprinttype")
			if archive == "" {
				archive, _ = db.Value(e, "archiveprefix")
			}
			if !strings.EqualFold(strings.TrimSpace(archive), "arxiv") {
				if eprint, _ := db.Value(e, "eprint"); eprint != "" {
					// A supplied non-arXiv eprint explicitly replaces the old
					// imported identity, rather than merely omitting a field.
					p.Metadata.Sources["arxiv"] = "bibtex"
				}
				continue
			}
		}
		value, _ := db.Value(e, f.Bib)
		if value != "" {
			*p.Metadata.textField(f.Meta) = value
			p.Metadata.Sources[f.Meta] = "bibtex"
		}
	}
	if p.Metadata.Date == "" {
		p.Metadata.Date, _ = db.Value(e, "year")
		if p.Metadata.Date != "" {
			p.Metadata.Sources["date"] = "bibtex"
		}
	}
	p.Metadata.DOI = NormalizeDOI(p.Metadata.DOI)
	p.Metadata.ArXiv = NormalizeArXiv(p.Metadata.ArXiv)
	return p, nil
}
func bibFill(p *PaperItem, in PaperItem) {
	if p.Metadata.Sources == nil {
		p.Metadata.Sources = map[string]string{}
	}
	if p.Metadata.Sources["title"] != "manual" {
		p.Title = in.Title
		p.Metadata.Sources["title"] = "bibtex"
	}
	if p.Metadata.Sources["creators"] != "manual" && len(in.Metadata.Creators) > 0 {
		// Refresh the summary only while it still follows the old creators.
		// A separately edited author remains authoritative during reimport.
		if p.Author == CreatorNames(p.Metadata.Creators) {
			p.Author = in.Author
		}
		p.Metadata.Creators = in.Metadata.Creators
		p.Metadata.Sources["creators"] = "bibtex"
	}
	for key := range metadataLabels {
		if key == "creators" || p.Metadata.Sources[key] == "manual" {
			continue
		}
		field, source := p.Metadata.textField(key), in.Metadata.textField(key)
		if field != nil && source != nil && (*source != "" || key == "arxiv" && in.Metadata.Sources[key] == "bibtex") {
			*field = *source
			p.Metadata.Sources[key] = "bibtex"
		}
	}
}

// One eprint slot cannot express a different raw archive and an edited arXiv
// identifier. Keep both stored values and require explicit user resolution.
func bibValidateEprint(p PaperItem, record paperBibRecord) error {
	if p.Metadata.ArXiv == "" || record.Baseline.Metadata.ArXiv != "" {
		return nil
	}
	eprint, err := record.Context.Value(record.Entry, "eprint")
	if err != nil {
		return err
	}
	if eprint != "" {
		return paperConflict("arXiv 标识符与原始非 arXiv eprint 冲突，请先明确保留哪一种标识符")
	}
	return nil
}

// Plain metadata edits must be escaped as text. Imported TeX is retained in the
// original expressions and does not pass through this plain-text encoder.
func bibLiteral(text string) string {
	replacer := strings.NewReplacer("\\", `\textbackslash{}`, "{", `\{`, "}", `\}`, "&", `\&`, "%", `\%`, "$", `\$`, "#", `\#`, "_", `\_`, "~", `\textasciitilde{}`, "^", `\textasciicircum{}`)
	return "{" + replacer.Replace(text) + "}"
}
func bibSet(e *bibliography.Entry, name, value string) {
	for i, f := range e.Fields {
		if f.Name == name {
			if value == "" {
				e.Fields = append(e.Fields[:i], e.Fields[i+1:]...)
			} else {
				e.Fields[i].Value = value
			}
			return
		}
	}
	if value != "" {
		e.Fields = append(e.Fields, bibliography.Field{Name: name, Value: value})
	}
}
func bibGet(e bibliography.Entry, name string) string {
	for _, f := range e.Fields {
		if f.Name == name {
			return f.Value
		}
	}
	return ""
}
func bibAuthor(p PaperItem) string {
	if len(p.Metadata.Creators) == 0 || p.Author != CreatorNames(p.Metadata.Creators) {
		return bibLiteral(p.Author)
	}
	names := []string{}
	for _, c := range p.Metadata.Creators {
		if c.Name != "" {
			names = append(names, "{"+strings.TrimSuffix(strings.TrimPrefix(bibLiteral(c.Name), "{"), "}")+"}")
		} else {
			name := c.Family
			if c.Given != "" {
				name += ", " + c.Given
			}
			names = append(names, strings.TrimSuffix(strings.TrimPrefix(bibLiteral(name), "{"), "}"))
		}
	}
	return "{" + strings.Join(names, " and ") + "}"
}
func bibEntry(p PaperItem, record paperBibRecord, hasRaw bool, mode string) bibliography.Entry {
	e := record.Entry
	e.Fields = append([]bibliography.Field{}, e.Fields...)
	if !hasRaw {
		e = bibliography.Entry{Type: bibKind(p.Metadata.ItemType, mode), Fields: []bibliography.Field{}}
	}
	e.Key = p.CitationKey
	base := record.Baseline
	if !hasRaw || p.Metadata.ItemType != base.Metadata.ItemType {
		e.Type = bibKind(p.Metadata.ItemType, mode)
	}
	if mode == "biblatex" {
		switch e.Type {
		case "techreport":
			e.Type = "report"
		case "phdthesis", "mastersthesis":
			if bibGet(e, "type") == "" {
				kind := e.Type
				if kind == "mastersthesis" {
					kind = "mathesis"
				}
				bibSet(&e, "type", bibLiteral(kind))
			}
			e.Type = "thesis"
		case "conference":
			e.Type = "inproceedings"
		}
		if e.Type == "thesis" && bibGet(e, "institution") == "" && bibGet(e, "school") != "" {
			bibSet(&e, "institution", bibGet(e, "school"))
		}
	}
	if mode == "bibtex" {
		switch e.Type {
		case "report":
			e.Type = "techreport"
		case "thesis":
			e.Type = "phdthesis"
			kind, _ := record.Context.Value(e, "type")
			if strings.EqualFold(kind, "mathesis") || strings.EqualFold(kind, "mastersthesis") {
				e.Type = "mastersthesis"
			}
		case "online":
			e.Type = "misc"
		}
		if (e.Type == "mastersthesis" || e.Type == "phdthesis") && bibGet(e, "school") == "" && bibGet(e, "institution") != "" {
			bibSet(&e, "school", bibGet(e, "institution"))
		}
	}
	if !hasRaw || p.Title != base.Title {
		bibSet(&e, "title", bibLiteral(p.Title))
	}
	if !hasRaw || !slices.Equal(p.Metadata.Creators, base.Metadata.Creators) || p.Author != base.Author {
		bibSet(&e, "author", bibAuthor(p))
	}
	for _, f := range bibMetadataFields {
		if f.Meta == "date" || f.Meta == "venue" {
			continue
		}
		value, old := p.Metadata.textField(f.Meta), base.Metadata.textField(f.Meta)
		if !hasRaw || *value != *old {
			v := ""
			if *value != "" {
				v = bibLiteral(*value)
			}
			bibSet(&e, f.Bib, v)
			if f.Meta == "arxiv" && *value != "" {
				bibSet(&e, "eprinttype", "{arxiv}")
				bibSet(&e, "archiveprefix", "")
			}
		}
	}
	venue := "journal"
	if p.Metadata.ItemType == "conference" || p.Metadata.ItemType == "chapter" {
		venue = "booktitle"
	}
	if mode == "biblatex" && venue == "journal" {
		venue = "journaltitle"
	}
	baseBookVenue := base.Metadata.ItemType == "conference" || base.Metadata.ItemType == "chapter"
	if !hasRaw || p.Metadata.Venue != base.Metadata.Venue || (venue == "booktitle") != baseBookVenue {
		value := ""
		if p.Metadata.Venue != "" {
			value = bibLiteral(p.Metadata.Venue)
			if hasRaw && p.Metadata.Venue == base.Metadata.Venue {
				// Match bibMapped's precedence while moving the original TeX or
				// macro expression to the field required by the corrected type.
				for _, name := range []string{"journal", "journaltitle", "booktitle"} {
					if raw := bibGet(e, name); raw != "" {
						if resolved, _ := record.Context.Value(e, name); resolved != "" {
							value = raw
						}
					}
				}
			}
		}
		for _, name := range []string{"journal", "journaltitle", "booktitle"} {
			bibSet(&e, name, "")
		}
		bibSet(&e, venue, value)
	} else if venue == "journaltitle" && bibGet(e, "journaltitle") == "" && bibGet(e, "journal") != "" {
		bibSet(&e, "journaltitle", bibGet(e, "journal"))
		bibSet(&e, "journal", "")
	} else if mode == "bibtex" && bibGet(e, "journal") == "" && bibGet(e, "journaltitle") != "" {
		bibSet(&e, "journal", bibGet(e, "journaltitle"))
		bibSet(&e, "journaltitle", "")
	}
	if !hasRaw || p.Metadata.Date != base.Metadata.Date {
		for _, name := range []string{"year", "date", "month", "day"} {
			bibSet(&e, name, "")
		}
		if p.Metadata.Date != "" {
			name, value := "date", p.Metadata.Date
			if mode == "bibtex" {
				name = "year"
				if len(value) > 4 {
					value = value[:4]
				}
			}
			bibSet(&e, name, bibLiteral(value))
			if mode == "bibtex" {
				parts := strings.Split(p.Metadata.Date, "-")
				if len(parts) > 1 {
					if month, err := strconv.Atoi(parts[1]); err == nil && month >= 1 && month <= 12 {
						bibSet(&e, "month", bibLiteral(bibMonthNames[month-1]))
					}
				}
				if len(parts) > 2 {
					bibSet(&e, "day", bibLiteral(parts[2]))
				}
			}
		}
	} else if mode == "biblatex" && bibGet(e, "date") == "" && bibGet(e, "year") != "" {
		bibSet(&e, "date", bibGet(e, "year"))
		bibSet(&e, "year", "")
	} else if mode == "bibtex" && bibGet(e, "year") == "" && bibGet(e, "date") != "" {
		year := p.Metadata.Date
		if len(year) > 4 {
			year = year[:4]
		}
		bibSet(&e, "year", bibLiteral(year))
	}
	// Classic styles ignore date; supply its components even for an untouched
	// imported expression, while retaining explicit year/month/day expressions.
	if mode == "bibtex" && bibGet(e, "date") != "" {
		parts := strings.Split(p.Metadata.Date, "-")
		if len(parts) > 1 && bibGet(e, "month") == "" {
			if month, err := strconv.Atoi(parts[1]); err == nil && month >= 1 && month <= 12 {
				bibSet(&e, "month", bibLiteral(bibMonthNames[month-1]))
			}
		}
		if len(parts) > 2 && bibGet(e, "day") == "" {
			bibSet(&e, "day", bibLiteral(parts[2]))
		}
	}
	return e
}

var bibMonthNames = []string{"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"}
