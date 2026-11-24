package interleaf

import (
	"os"
	"slices"
	"testing"
)

// The remaining subprocess fixture is the non-AI document processor.
func TestMain(m *testing.M) {
	if output := os.Getenv("BABELDOC_READING_FIXTURE_OUTPUT"); output != "" && slices.Contains(os.Args, "--openai") {
		os.Exit(runBabelDOCReadingFixture(output))
	}
	if os.Getenv("INTERLEAF_AGENT_HELPER") != "" {
		if os.Getenv("INTERLEAF_AGENT_MODE") == "corpus-worker" {
			runMissingPageCorpusProcess()
			os.Exit(0)
		}
		os.Exit(99)
	}
	os.Exit(m.Run())
}
