package interleaf

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"

	"rsc.io/pdf"
)

const babeldocGeometryTolerance = 0.01 // PDF points at PDF.js viewport scale 1.
const babeldocMaxPages = 10_000
const babeldocMaxPageTreeNodes = 2 * babeldocMaxPages

func babeldocReadingReport(ctx context.Context, original, mono []byte) (nativeReadingReport, error) {
	if bytes.Equal(original, mono) {
		return nativeReadingReport{}, errors.New("BabelDOC output is identical to source")
	}
	sourcePages, err := babeldocPDFPages(ctx, original)
	if err != nil {
		return nativeReadingReport{}, fmt.Errorf("invalid source PDF: %w", err)
	}
	outputPages, err := babeldocPDFPages(ctx, mono)
	if err != nil {
		return nativeReadingReport{}, fmt.Errorf("invalid BabelDOC output PDF: %w", err)
	}
	if len(sourcePages) != len(outputPages) {
		return nativeReadingReport{}, errors.New("BabelDOC output page count differs from source")
	}
	for i, page := range outputPages {
		if math.Abs(page.Width-sourcePages[i].Width) > babeldocGeometryTolerance ||
			math.Abs(page.Height-sourcePages[i].Height) > babeldocGeometryTolerance {
			return nativeReadingReport{}, fmt.Errorf("BabelDOC output page %d viewport differs from source", i+1)
		}
	}
	return nativeReadingReport{Pages: outputPages, Warnings: []string{}}, nil
}

type babeldocPDFProperties struct {
	mediaBox, cropBox, rotate pdf.Value
}

func babeldocPDFPages(ctx context.Context, data []byte) (pages []nativeReadingPage, err error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	defer func() {
		// As with the import page counter, rsc.io/pdf can panic on malformed input.
		if recover() != nil {
			pages, err = nil, errors.New("malformed PDF")
		}
	}()
	reader, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	catalog := reader.Trailer().Key("Root")
	tree := catalog.Key("Pages")
	if catalog.Key("Type").Name() != "Catalog" || tree.Key("Type").Name() != "Pages" {
		return nil, errors.New("missing PDF page tree")
	}
	count := tree.Key("Count").Int64()
	if count <= 0 || count > babeldocMaxPages {
		return nil, errors.New("invalid or excessive PDF page count")
	}
	budget := babeldocMaxPageTreeNodes
	pages, ok := appendBabelDOCPages(ctx, nil, tree, babeldocPDFProperties{}, 0, &budget)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !ok || int64(len(pages)) != count {
		return nil, errors.New("invalid PDF page tree or geometry")
	}
	return pages, nil
}

// Walk the actual Kids arrays in page order. Inherited values come from the
// tree rather than the page's Parent pointer, which can refer back to itself.
func appendBabelDOCPages(ctx context.Context, pages []nativeReadingPage, node pdf.Value, inherited babeldocPDFProperties, depth int, budget *int) ([]nativeReadingPage, bool) {
	if depth > 64 || *budget == 0 || ctx.Err() != nil {
		return nil, false
	}
	(*budget)--
	if box := node.Key("MediaBox"); !box.IsNull() {
		inherited.mediaBox = box
	}
	if box := node.Key("CropBox"); !box.IsNull() {
		inherited.cropBox = box
	}
	if rotate := node.Key("Rotate"); !rotate.IsNull() {
		inherited.rotate = rotate
	}
	switch node.Key("Type").Name() {
	case "Pages":
		before := len(pages)
		kids := node.Key("Kids")
		count := node.Key("Count").Int64()
		if count <= 0 || kids.Len() == 0 {
			return nil, false
		}
		for i := 0; i < kids.Len(); i++ {
			var ok bool
			pages, ok = appendBabelDOCPages(ctx, pages, kids.Index(i), inherited, depth+1, budget)
			if !ok || int64(len(pages)-before) > count {
				return nil, false
			}
		}
		return pages, int64(len(pages)-before) == count
	case "Page":
		width, height, ok := babeldocPDFViewport(inherited, node.Key("UserUnit"))
		if !ok {
			return nil, false
		}
		return append(pages, nativeReadingPage{
			Page:        len(pages) + 1,
			Width:       width,
			Height:      height,
			OutputWidth: width,
			Paragraphs:  []nativeReadingParagraph{},
		}), true
	default:
		return nil, false
	}
}

func babeldocPDFViewport(properties babeldocPDFProperties, userUnit pdf.Value) (width, height float64, valid bool) {
	view, ok := babeldocPDFBox(properties.mediaBox)
	if !ok {
		return 0, 0, false
	}
	if crop, ok := babeldocPDFBox(properties.cropBox); ok {
		intersection := [4]float64{
			math.Max(view[0], crop[0]), math.Max(view[1], crop[1]),
			math.Min(view[2], crop[2]), math.Min(view[3], crop[3]),
		}
		if intersection[2] > intersection[0] && intersection[3] > intersection[1] {
			view = intersection
		}
	}
	scale := userUnit.Float64()
	if scale <= 0 || !finiteNativeReadingNumber(scale) {
		scale = 1
	}
	width, height = (view[2]-view[0])*scale, (view[3]-view[1])*scale
	switch math.Mod(properties.rotate.Float64(), 360) {
	case 90, -270, 270, -90:
		width, height = height, width
	}
	return width, height, width > 0 && height > 0 && finiteNativeReadingNumber(width) && finiteNativeReadingNumber(height)
}

func babeldocPDFBox(value pdf.Value) (box [4]float64, valid bool) {
	if value.Len() != len(box) {
		return box, false
	}
	for i := range box {
		coordinate := value.Index(i)
		if coordinate.Kind() != pdf.Integer && coordinate.Kind() != pdf.Real {
			return box, false
		}
		box[i] = coordinate.Float64()
		if !finiteNativeReadingNumber(box[i]) {
			return box, false
		}
	}
	box[0], box[2] = math.Min(box[0], box[2]), math.Max(box[0], box[2])
	box[1], box[3] = math.Min(box[1], box[3]), math.Max(box[1], box[3])
	return box, box[2] > box[0] && box[3] > box[1]
}
