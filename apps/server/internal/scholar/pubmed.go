package scholar

import (
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
)

const pmidDigits = `[1-9][0-9]{0,9}`
const pmidPrefix = `pmid(?:\s*[:：]\s*|\s+)`
const pubMedHost = "pubmed.ncbi.nlm.nih.gov"

var (
	pmidLabel = regexp.MustCompile(`(?i)^` + pmidPrefix + `(` + pmidDigits + `)$`)
	pmidText  = regexp.MustCompile(`(?i)\b` + pmidPrefix + `(` + pmidDigits + `)\b`)
	pmidValue = regexp.MustCompile(`^` + pmidDigits + `$`)
)

func pubMedRef(ref string) string {
	ref = strings.TrimSpace(ref)
	if m := pmidLabel.FindStringSubmatch(ref); m != nil {
		return m[1]
	}
	u, err := url.Parse(ref)
	if err != nil || u.User != nil || !strings.EqualFold(u.Host, pubMedHost) ||
		(u.Scheme != "https" && u.Scheme != "http") {
		return ""
	}
	id := strings.TrimSuffix(strings.TrimPrefix(u.Path, "/"), "/")
	if pmidValue.MatchString(id) {
		return id
	}
	return ""
}

type pubMedArticle struct {
	Metadata Metadata
	PDFURLs  []string
}

type europePMCRecord struct {
	ID                   string `json:"id"`
	Source               string `json:"source"`
	Title                string `json:"title"`
	DOI                  string `json:"doi"`
	AbstractText         string `json:"abstractText"`
	FirstPublicationDate string `json:"firstPublicationDate"`
	PubYear              string `json:"pubYear"`
	PageInfo             string `json:"pageInfo"`
	JournalInfo          struct {
		Volume  string `json:"volume"`
		Issue   string `json:"issue"`
		Journal struct {
			Title string `json:"title"`
		} `json:"journal"`
	} `json:"journalInfo"`
	AuthorList struct {
		Author []struct {
			FirstName      string `json:"firstName"`
			LastName       string `json:"lastName"`
			FullName       string `json:"fullName"`
			CollectiveName string `json:"collectiveName"`
		} `json:"author"`
	} `json:"authorList"`
	FullTextURLList struct {
		Links []struct {
			AvailabilityCode string `json:"availabilityCode"`
			DocumentStyle    string `json:"documentStyle"`
			URL              string `json:"url"`
		} `json:"fullTextUrl"`
	} `json:"fullTextUrlList"`
}

// pubMed resolves an exact MED record using the public Europe PMC Articles API.
func (c *Client) pubMed(ctx context.Context, id string) (pubMedArticle, error) {
	if !pmidValue.MatchString(id) {
		return pubMedArticle{}, ErrNotFound
	}
	params := url.Values{
		"query":      {"EXT_ID:" + id + " AND SRC:MED"},
		"format":     {"json"},
		"resultType": {"core"},
		"pageSize":   {"1"},
	}
	resource, err := c.fetchPublic(ctx, c.EuropePMC+"search?"+params.Encode(), "application/json", 5<<20, "europepmc", "", true)
	if err != nil {
		return pubMedArticle{}, err
	}
	var body struct {
		ResultList struct {
			Records []europePMCRecord `json:"result"`
		} `json:"resultList"`
	}
	if err := json.Unmarshal(resource.Bytes, &body); err != nil {
		return pubMedArticle{}, Error{"Europe PMC 返回了无法识别的数据"}
	}
	for _, record := range body.ResultList.Records {
		if record.ID == id && record.Source == "MED" {
			if article := record.article(); article.Metadata.Title != "" {
				return article, nil
			}
		}
	}
	return pubMedArticle{}, ErrNotFound
}

func (r europePMCRecord) article() pubMedArticle {
	m := Metadata{
		Title:    clean(PublicText(r.Title)),
		DOI:      strings.TrimSpace(r.DOI),
		Abstract: PublicText(r.AbstractText),
		Date:     r.FirstPublicationDate,
		Venue:    clean(r.JournalInfo.Journal.Title),
		Volume:   clean(r.JournalInfo.Volume),
		Issue:    clean(r.JournalInfo.Issue),
		Pages:    clean(r.PageInfo),
		URL:      "https://" + pubMedHost + "/" + r.ID + "/",
	}
	if m.Venue != "" {
		m.ItemType = "journal"
	}
	if m.Date == "" {
		m.Date = r.PubYear
	}
	for _, a := range r.AuthorList.Author {
		var author Creator
		switch {
		case a.CollectiveName != "":
			author.Name = clean(a.CollectiveName)
		case a.LastName != "":
			author.Given, author.Family = clean(a.FirstName), clean(a.LastName)
		default:
			author = splitName(a.FullName)
		}
		if author != (Creator{}) {
			m.Creators = append(m.Creators, author)
		}
	}
	article := pubMedArticle{Metadata: m}
	for _, link := range r.FullTextURLList.Links {
		if !strings.EqualFold(link.DocumentStyle, "pdf") ||
			(link.AvailabilityCode != "OA" && link.AvailabilityCode != "F") {
			continue
		}
		// The downloader validates each URL, including redirects and DNS.
		if raw := strings.TrimSpace(link.URL); raw != "" {
			article.PDFURLs = append(article.PDFURLs, raw)
		}
	}
	return article
}
