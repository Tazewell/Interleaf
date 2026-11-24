package interleaf

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestBabelDOCReadingReportRejectsInvalidPDFs(t *testing.T) {
	original := testPDF(1)
	translated := append(testPDF(1), ' ')
	badCount := bytes.Replace(translated, []byte("/Count 1"), []byte("/Count 2"), 1)
	cyclicPages := bytes.Replace(translated, []byte("/Kids [3 0 R]"), []byte("/Kids [2 0 R]"), 1)
	for _, tc := range []struct {
		name           string
		original, mono []byte
	}{
		{"invalid source", []byte("%PDF-1.4\nmissing objects"), translated},
		{"invalid output", original, []byte("%PDF-1.4\nmissing objects")},
		{"identical source and output", original, original},
		{"empty page tree", testPDF(0), append(testPDF(0), ' ')},
		{"page counts differ", original, testPDF(2)},
		{"invalid page count", badCount, testPDF(2)},
		{"cyclic page tree", original, cyclicPages},
		{"physical size differs", original, babeldocGeometryPDF("", "/MediaBox [0 0 612 790]")},
		{"crop changes visible size", original, babeldocGeometryPDF("", "/MediaBox [0 0 612 792] /CropBox [5 5 610 790]")},
		{"rotation changes visible size", original, babeldocGeometryPDF("", "/MediaBox [0 0 612 792] /Rotate 90")},
		{"user unit changes physical size", original, babeldocGeometryPDF("", "/MediaBox [0 0 612 792] /UserUnit 2")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := babeldocReadingReport(t.Context(), tc.original, tc.mono); err == nil {
				t.Fatal("accepted invalid mono PDF")
			}
		})
	}
}

func TestBabelDOCReadingReportBuildsVerifiedPageGeometry(t *testing.T) {
	for _, tc := range []struct {
		name           string
		original, mono []byte
		pageCount      int
		width, height  float64
	}{
		{"sequential pages", testPDF(2), append(testPDF(2), ' '), 2, 612, 792},
		{
			"inherit and normalize crop and rotation",
			babeldocGeometryPDF("/MediaBox [0 0 500 800] /CropBox [490 810 10 20] /Rotate -90", "/UserUnit 1.25"),
			babeldocGeometryPDF("", "/MediaBox [0 0 500 800] /CropBox [10 20 490 800] /Rotate 270 /UserUnit 1.25"),
			1, 975, 600,
		},
		{
			"small rounding differences use output viewport",
			babeldocGeometryPDF("", "/MediaBox [0 0 612 792]"),
			babeldocGeometryPDF("", "/MediaBox [0 0 611.999 792]"),
			1, 611.999, 792,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			report, err := babeldocReadingReport(t.Context(), tc.original, tc.mono)
			if err != nil {
				t.Fatal(err)
			}
			if len(report.Pages) != tc.pageCount || report.Warnings == nil || report.Translated != 0 || report.Original != 0 {
				t.Fatalf("invalid manifest report: %+v", report)
			}
			for i, page := range report.Pages {
				if page.Page != i+1 || page.Width != tc.width || page.Height != tc.height || page.OutputWidth != tc.width || page.TranslationOffsetX != 0 || page.Paragraphs == nil || len(page.Paragraphs) != 0 {
					t.Fatalf("invalid geometry for page %d: %+v", i+1, page)
				}
			}
		})
	}
}

func TestBabelDOCReadingReportRejectsOversizedPageTree(t *testing.T) {
	source := testPDF(10_001)
	mono := bytes.Replace(source, []byte("%PDF-1.4"), []byte("%PDF-1.5"), 1)
	if _, err := babeldocReadingReport(t.Context(), source, mono); err == nil {
		t.Fatal("verification accepted a PDF larger than the page validation limit")
	}
}

func TestBabelDOCReadingReportHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	source := testPDF(1)
	if _, err := babeldocReadingReport(ctx, source, append(bytes.Clone(source), ' ')); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
}

func babeldocGeometryPDF(inherited, own string) []byte {
	var out bytes.Buffer
	out.WriteString("%PDF-1.4\n")
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 " + inherited + " >>",
		"<< /Type /Page /Parent 2 0 R " + own + " >>",
	}
	offsets := make([]int, len(objects))
	for i, body := range objects {
		offsets[i] = out.Len()
		fmt.Fprintf(&out, "%d 0 obj\n%s\nendobj\n", i+1, body)
	}
	xref := out.Len()
	out.WriteString("xref\n0 4\n0000000000 65535 f \n")
	for _, offset := range offsets {
		fmt.Fprintf(&out, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&out, "trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", xref)
	return out.Bytes()
}
