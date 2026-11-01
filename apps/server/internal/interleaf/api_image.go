package interleaf

import (
	"encoding/base64"
)

func imageData(b []byte) string {
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(b)
}
