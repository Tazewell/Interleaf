package interleaf

import (
	"bytes"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const babeldocConsoleRowLimit = 2048

var (
	babeldocANSI       = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
	babeldocOverallRow = regexp.MustCompile(`^translate +[ ━─╸╺-]*([0-9]{1,3})/100 +([0-9]{1,4}:[0-5][0-9]:[0-5][0-9]) +(-:--:--|[0-9]{1,4}:[0-5][0-9]:[0-5][0-9])$`)
	babeldocStageRow   = regexp.MustCompile(`^([A-Za-z ]{1,70}) \(([0-9]{1,5})/([0-9]{1,5})\) +[ ━─╸╺-]*([0-9]{1,9})/([0-9]{1,9}) +[0-9]{1,4}:[0-5][0-9]:[0-5][0-9] +(?:-:--:--|[0-9]{1,4}:[0-5][0-9]:[0-5][0-9])$`)
)

type babeldocProgressSample struct {
	phase      string
	hasPercent bool
	percent    int
	remaining  time.Duration
}

// Rich redraws entire frames, including old rows. Consume a bounded line at a
// time and forward only recognized phase identifiers and numeric counters.
type babeldocProgressConsole struct {
	report       func(babeldocProgressSample)
	row          []byte
	discard      bool
	part         int
	phase        string
	phaseRank    int
	lastPercent  int
	lastElapsed  time.Duration
	lastEstimate time.Duration
	havePercent  bool
}

func (p *babeldocProgressConsole) Write(data []byte) (int, error) {
	size := len(data)
	for len(data) > 0 {
		breakAt := bytes.IndexAny(data, "\r\n")
		if breakAt < 0 {
			p.append(data)
			break
		}
		p.append(data[:breakAt])
		if !p.discard && len(p.row) > 0 {
			p.parseRow(p.row)
		}
		p.row, p.discard = p.row[:0], false
		data = data[breakAt+1:]
	}
	return size, nil
}

func (p *babeldocProgressConsole) append(part []byte) {
	if p.discard {
		return
	}
	if len(p.row)+len(part) > babeldocConsoleRowLimit {
		p.discard = true
		return
	}
	p.row = append(p.row, part...)
}

func (p *babeldocProgressConsole) parseRow(raw []byte) {
	row := strings.TrimRight(string(babeldocANSI.ReplaceAll(raw, nil)), " \t")
	if overall := babeldocOverallRow.FindStringSubmatch(row); overall != nil {
		value, _ := strconv.Atoi(overall[1])
		if value > 100 || p.havePercent && value < p.lastPercent {
			return
		}
		elapsed := babeldocConsoleDuration(overall[2])
		var estimate time.Duration
		if value >= 10 && value < 97 && elapsed >= 5*time.Second {
			estimate = babeldocConsoleDuration(overall[3])
			if estimate > bilingualPDFTTL {
				estimate = 0
			}
		}
		if p.havePercent && value == p.lastPercent {
			if elapsed < p.lastElapsed {
				return
			}
			p.lastElapsed = elapsed
			// A redraw with different elapsed time alone must not make an
			// unchanged ETA fresh again.
			if estimate == p.lastEstimate {
				return
			}
		}
		p.lastPercent, p.lastElapsed, p.lastEstimate, p.havePercent = value, elapsed, estimate, true
		p.report(babeldocProgressSample{hasPercent: true, percent: min(99, value), remaining: estimate})
		return
	}
	stage := babeldocStageRow.FindStringSubmatch(row)
	if stage == nil {
		return
	}
	phase, rank := babeldocConsolePhase(stage[1])
	part, _ := strconv.Atoi(stage[2])
	parts, _ := strconv.Atoi(stage[3])
	current, _ := strconv.Atoi(stage[4])
	total, _ := strconv.Atoi(stage[5])
	if phase == "" || part == 0 || part > parts || parts > babeldocMaxPages || current > total ||
		part < p.part || part == p.part && rank <= p.phaseRank {
		return
	}
	p.part, p.phaseRank = part, rank
	if phase != p.phase {
		p.phase = phase
		p.report(babeldocProgressSample{phase: phase})
	}
}

func babeldocConsolePhase(stage string) (string, int) {
	switch stage {
	case "Parse PDF and Create Intermediate Representation", "DetectScannedFile", "Parse Page Layout",
		"Parse Table", "Parse Paragraphs", "Parse Formulas and Styles":
		return "layout", 1
	case "Automatic Term Extraction":
		return "terminology", 2
	case "Translate Paragraphs":
		return "translation", 3
	case "Typesetting", "Add Fonts", "Generate drawing instructions", "Subset font":
		return "typesetting", 4
	case "Save PDF":
		return "saving", 5
	default:
		return "", 0
	}
}

func babeldocConsoleDuration(value string) time.Duration {
	hours, rest, ok := strings.Cut(value, ":")
	if !ok || value == "-:--:--" {
		return 0
	}
	minutes, seconds, _ := strings.Cut(rest, ":")
	h, _ := strconv.Atoi(hours)
	m, _ := strconv.Atoi(minutes)
	s, _ := strconv.Atoi(seconds)
	return time.Duration(h)*time.Hour + time.Duration(m)*time.Minute + time.Duration(s)*time.Second
}

type nativeReadingProgress struct {
	Phase            string `json:"phase,omitempty"`
	Percent          *int   `json:"percent,omitempty"`
	ElapsedSeconds   int    `json:"elapsedSeconds"`
	RemainingSeconds *int   `json:"remainingSeconds,omitempty"`
}

// The job mutex protects this state across the console reader and HTTP polls.
type babeldocReadingProgress struct {
	startedAt   time.Time
	updatedAt   time.Time
	remainingTo time.Time
	phase       string
	percent     *int
}

func (p *babeldocReadingProgress) start(now time.Time) {
	p.startedAt, p.phase = now, "preparing"
}

func (p *babeldocReadingProgress) record(now time.Time, sample babeldocProgressSample) {
	if sample.phase != "" {
		p.phase = sample.phase
	}
	if sample.hasPercent {
		p.percent = &sample.percent
		p.updatedAt = now
		p.remainingTo = now.Add(sample.remaining)
	}
}

func (p *babeldocReadingProgress) snapshot(now time.Time, status string) *nativeReadingProgress {
	if p.startedAt.IsZero() {
		return nil
	}
	progress := &nativeReadingProgress{Phase: p.phase, Percent: p.percent, ElapsedSeconds: max(0, int(now.Sub(p.startedAt)/time.Second))}
	if status == "ready" {
		done := 100
		progress.Percent = &done
	} else if status == "running" && now.Sub(p.updatedAt) <= 30*time.Second {
		if remaining := p.remainingTo.Sub(now); remaining > 0 {
			coarse := int((remaining+5*time.Second-time.Nanosecond)/(5*time.Second)) * 5
			progress.RemainingSeconds = &coarse
		}
	}
	return progress
}
