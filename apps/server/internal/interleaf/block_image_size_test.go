package interleaf

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func blocksResponse(t *testing.T, s *Server) []map[string]any {
	t.Helper()
	request := httptest.NewRequest("GET", "/", nil)
	request.SetPathValue("id", "doc")
	response := httptest.NewRecorder()
	s.documentBlocks(response, request)
	var blocks []map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &blocks); err != nil || response.Code != 200 {
		t.Fatalf("blocks response: %d %s (%v)", response.Code, response.Body.String(), err)
	}
	return blocks
}

func TestBlockImageSizeLegacyReadOnlyBackfill(t *testing.T) {
	s, _ := processingFixture(t)
	dir := s.analysisDir("doc")
	manifest := filepath.Join(dir, "manifest.json")
	before, _ := os.ReadFile(manifest)
	var imageData bytes.Buffer
	if err := png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 366, 166))); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "p1-b1.png"), imageData.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	blocks := blocksResponse(t, s)
	size, _ := blocks[0]["imageSize"].(map[string]any)
	if size["width"] != float64(366) || size["height"] != float64(166) {
		t.Fatalf("missing exact crop geometry: %#v", blocks)
	}
	after, _ := os.ReadFile(manifest)
	if !bytes.Equal(before, after) {
		t.Fatal("read rewrote legacy manifest")
	}
}

func TestBlockImageSizeUnreadableDoesNotHideBlocks(t *testing.T) {
	for _, content := range [][]byte{nil, []byte("corrupt png")} {
		t.Run(string(content), func(t *testing.T) {
			s, _ := processingFixture(t)
			if content != nil {
				_ = os.WriteFile(filepath.Join(s.analysisDir("doc"), "assets", "p1-b1.png"), content, 0600)
			}
			blocks := blocksResponse(t, s)
			if len(blocks) != 1 || blocks[0]["imageSize"] != nil {
				t.Fatalf("lost legacy block: %#v", blocks)
			}
		})
	}
}

func TestBlockImageSizeDoesNotFollowOutsideSymlink(t *testing.T) {
	s, _ := processingFixture(t)
	var imageData bytes.Buffer
	_ = png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 9, 7)))
	outside := filepath.Join(t.TempDir(), "outside.png")
	_ = os.WriteFile(outside, imageData.Bytes(), 0600)
	if err := os.Symlink(outside, filepath.Join(s.analysisDir("doc"), "assets", "p1-b1.png")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	blocks := blocksResponse(t, s)
	if len(blocks) != 1 || blocks[0]["imageSize"] != nil {
		t.Fatalf("read outside analysis root: %#v", blocks)
	}
}

func TestBlockImageSizePreservesMetadataAndRejectsUnsafePaths(t *testing.T) {
	known := &PDFBlockImageSize{Width: 180, Height: 46}
	blocks := []PDFBlock{
		{ID: "p1-b1", Image: "assets/p1-b1.png", ImageSize: known},
		{ID: "p1-b2", Image: "../outside.png"},
		{ID: "p1-b3", Image: "assets/p1-b3.png", ImageSize: &PDFBlockImageSize{Width: -1, Height: 20}},
		{ID: "p1-b4", Image: "assets/p1-b4.png", ImageSize: &PDFBlockImageSize{Width: 32_000_000, Height: 32_000_000}},
	}
	fillBlockImageSizes(t.TempDir(), blocks)
	if blocks[0].ImageSize != known {
		t.Fatal("replaced known metadata without an image read")
	}
	for _, block := range blocks[1:] {
		if block.ImageSize != nil {
			t.Fatalf("unsafe image dimensions: %+v", block)
		}
	}
}
