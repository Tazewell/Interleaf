package interleaf

import (
	"strings"
	"testing"
	"time"
)

func TestBabelDOCProgressAcceptsOnlyRecognizedCounters(t *testing.T) {
	var samples []babeldocProgressSample
	console := babeldocProgressConsole{report: func(sample babeldocProgressSample) {
		samples = append(samples, sample)
	}}
	chunks := []string{
		"INFO private diagnostic has translate 99/100 0:02:00 0:00:10\n",
		"                       translate 99/100 0:02:00 0:00:10\n",
		"translate                                0/100 0:00:00 -:--:--\r",
		"\x1b[2K\x1b[33mAutomatic Term Extr",
		"action (1/2)\x1b[0m                      0/11 0:00:00 -:--:--\r",
		"\x1b[2Ktranslate              \x1b[32m━━━━╸\x1b[0m    37/100 0:00:23 0:00:32\r\n",
		"Parse Page Layout (1/2) 3/3 0:00:01 0:00:00\n",
		"Translate Paragraphs (1/2) 0/19 0:00:00 -:--:--\n",
		"translate                                  31/100 0:00:25 0:01:00\n",
		"Save PDF (1/2) 3/2 0:00:00 -:--:--\n",
		strings.Repeat("x", 10000) + "translate 95/100 0:01:00 0:00:10\n",
		"Translate Paragraphs (1/2) 9/19 0:00:03 0:00:04\n",
		"Save PDF (1/2) 1/2 0:00:00 -:--:--\n",
		"Parse Page Layout (2/2) 0/3 0:00:00 -:--:--\n",
		"Save PDF (1/2) 2/2 0:00:01 0:00:00\n",
		"translate                                 100/100 0:02:00 0:00:00\n",
	}
	for _, chunk := range chunks {
		n, err := console.Write([]byte(chunk))
		if n != len(chunk) || err != nil {
			t.Fatalf("progress writer did not drain the child: %d, %v", n, err)
		}
	}
	if len(samples) != 7 {
		t.Fatalf("unexpected samples: %+v", samples)
	}
	if !samples[0].hasPercent || samples[0].percent != 0 ||
		samples[1].phase != "terminology" || samples[2].percent != 37 ||
		samples[2].remaining != 32*time.Second || samples[3].phase != "translation" ||
		samples[4].phase != "saving" || samples[5].phase != "layout" ||
		samples[6].percent != 99 {
		t.Fatalf("incorrect or unbounded progress samples: %+v", samples)
	}
}

func TestBabelDOCProgressEstimateExpiresWithoutInventingPercent(t *testing.T) {
	started := time.Now()
	var tracker babeldocReadingProgress
	tracker.start(started)
	start := tracker.snapshot(started.Add(3*time.Second), "running")
	if start.Phase != "preparing" || start.ElapsedSeconds != 3 || start.Percent != nil || start.RemainingSeconds != nil {
		t.Fatalf("made up an estimate before engine output: %+v", start)
	}
	tracker.record(started.Add(9*time.Second), babeldocProgressSample{phase: "translation"})
	tracker.record(started.Add(10*time.Second), babeldocProgressSample{hasPercent: true, percent: 31, remaining: 54 * time.Second})
	fresh := tracker.snapshot(started.Add(13*time.Second), "running")
	if fresh.Phase != "translation" || fresh.ElapsedSeconds != 13 || fresh.Percent == nil || *fresh.Percent != 31 ||
		fresh.RemainingSeconds == nil || *fresh.RemainingSeconds != 55 {
		t.Fatalf("missing or incorrect engine estimate: %+v", fresh)
	}
	stalled := tracker.snapshot(started.Add(50*time.Second), "running")
	if stalled.ElapsedSeconds != 50 || stalled.Percent == nil || *stalled.Percent != 31 || stalled.RemainingSeconds != nil {
		t.Fatalf("continued to advance or estimate a stalled job: %+v", stalled)
	}
	ready := tracker.snapshot(started.Add(time.Minute), "ready")
	if ready.Percent == nil || *ready.Percent != 100 || ready.RemainingSeconds != nil {
		t.Fatalf("did not complete progress on publication: %+v", ready)
	}
}

func TestBabelDOCProgressUpdatesEstimatesWithoutAdvancingPercent(t *testing.T) {
	started := time.Now()
	now := started
	var tracker babeldocReadingProgress
	tracker.start(now)
	console := babeldocProgressConsole{report: func(sample babeldocProgressSample) {
		tracker.record(now, sample)
	}}
	tests := []struct {
		at            time.Duration
		row           string
		wantRemaining int
	}{
		{10 * time.Second, "translate 51/100 0:00:09 -:--:--\n", 0},
		{11 * time.Second, "translate 51/100 0:00:10 0:01:00\n", 60},
		{13 * time.Second, "translate 51/100 0:00:12 0:00:52\n", 55},
		{14 * time.Second, "translate 51/100 0:00:10 0:01:00\n", 55},
		{15 * time.Second, "translate 50/100 0:00:14 0:01:10\n", 50},
		{16 * time.Second, "translate 51/100 0:00:15 -:--:--\n", 0},
		{17 * time.Second, "translate 51/100 0:00:16 0:01:00\n", 60},
		{46 * time.Second, "translate 51/100 0:00:45 0:01:00\n", 35},
		{48 * time.Second, "translate 51/100 0:00:47 0:01:00\n", 0},
	}
	for _, tt := range tests {
		now = started.Add(tt.at)
		if _, err := console.Write([]byte(tt.row)); err != nil {
			t.Fatal(err)
		}
		got := tracker.snapshot(now, "running")
		if got.Percent == nil || *got.Percent != 51 {
			t.Fatalf("at %v, percentage changed despite no additional progress: %+v", tt.at, got)
		}
		if tt.wantRemaining == 0 && got.RemainingSeconds != nil ||
			tt.wantRemaining > 0 && (got.RemainingSeconds == nil || *got.RemainingSeconds != tt.wantRemaining) {
			t.Fatalf("at %v, ETA=%v, want %d seconds", tt.at, got.RemainingSeconds, tt.wantRemaining)
		}
	}
}
