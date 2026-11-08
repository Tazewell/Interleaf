package interleaf

import (
	"image/png"
	"io"
	"os"
)

// PDFBlockImageSize is the persisted crop's pixel size, including its margin.
type PDFBlockImageSize struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

func validBlockImageSize(size *PDFBlockImageSize) bool {
	return size != nil && size.Width > 0 && size.Height > 0 && size.Width <= 32_000_000 && size.Height <= 32_000_000 && int64(size.Width)*int64(size.Height) <= 32_000_000
}

// Legacy manifests remain untouched. Only a bounded PNG header is read; a bad
// or missing crop must never make the rest of the document unreadable.
func fillBlockImageSizes(dir string, blocks []PDFBlock) {
	var root *os.Root
	defer func() {
		if root != nil {
			_ = root.Close()
		}
	}()
	for i := range blocks {
		block := &blocks[i]
		if validBlockImageSize(block.ImageSize) {
			continue
		}
		block.ImageSize = nil
		if block.Image == "" || !validBlockImage(*block) {
			continue
		}
		if root == nil {
			var err error
			root, err = os.OpenRoot(dir)
			if err != nil {
				return
			}
		}
		file, err := root.Open(block.Image)
		if err != nil {
			continue
		}
		config, err := png.DecodeConfig(io.LimitReader(file, 64<<10))
		_ = file.Close()
		if err != nil {
			continue
		}
		size := &PDFBlockImageSize{Width: config.Width, Height: config.Height}
		if validBlockImageSize(size) {
			block.ImageSize = size
		}
	}
}
