package reader

import (
	"os"
	"testing"
)

// The remaining subprocess fixture is the non-AI document processor.
func TestMain(m *testing.M) {
	if os.Getenv("READER_AGENT_HELPER") != "" {
		if os.Getenv("READER_AGENT_MODE") == "corpus-worker" {
			runMissingPageCorpusProcess()
			os.Exit(0)
		}
		os.Exit(99)
	}
	os.Exit(m.Run())
}
