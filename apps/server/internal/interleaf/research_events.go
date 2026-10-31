package interleaf

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

const researchEventLimit = 8 << 20

type researchEvent struct {
	Sequence int64           `json:"sequence"`
	Type     string          `json:"type"`
	Data     json.RawMessage `json:"data"`
}
type researchEventLog struct {
	events []researchEvent
	bytes  int
}

func (s *Server) publishResearchEvent(runID, kind string, data any) error {
	s.researchEventsMu.Lock()
	defer s.researchEventsMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	r, err := readResearchRecord(ctx, tx, runID)
	if err != nil {
		return err
	}
	r.EventSequence++
	if err = writeResearchRecord(ctx, tx, r); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if s.researchEvents == nil {
		s.researchEvents = map[string]*researchEventLog{}
	}
	log := s.researchEvents[runID]
	if log == nil {
		log = &researchEventLog{}
		s.researchEvents[runID] = log
	}
	ev := researchEvent{Sequence: r.EventSequence, Type: kind, Data: json.RawMessage(jsonText(data))}
	size := len(ev.Data) + len(kind) + 32
	if size > researchEventLimit {
		log.events = nil
		log.bytes = 0
		return nil
	}
	log.events = append(log.events, ev)
	log.bytes += size
	total := 0
	for _, l := range s.researchEvents {
		total += l.bytes
	}
	// A process-wide cap bounds abandoned subscribers/runs too. Lost replay is
	// represented by reset, never by re-running generation.
	for id, l := range s.researchEvents {
		if total <= researchEventLimit {
			break
		}
		if id != runID {
			total -= l.bytes
			delete(s.researchEvents, id)
		}
	}
	for total > researchEventLimit && len(log.events) > 0 {
		n := len(log.events[0].Data) + len(log.events[0].Type) + 32
		log.events = log.events[1:]
		log.bytes -= n
		total -= n
	}
	return nil
}
func (s *Server) researchEventsHTTP(w http.ResponseWriter, r *http.Request) {
	after := int64(0)
	var err error
	if raw := r.URL.Query().Get("after"); raw != "" {
		after, err = strconv.ParseInt(raw, 10, 64)
	}
	if err != nil || after < 0 {
		fail(w, 400, "事件序号无效")
		return
	}
	runID := r.PathValue("run")
	if _, err = s.getResearchRun(r.Context(), runID); err != nil {
		paperError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	controller := http.NewResponseController(w)
	defer controller.SetWriteDeadline(time.Time{})
	send := func(seq int64, kind string, data any) bool {
		_ = controller.SetWriteDeadline(time.Now().Add(15 * time.Second))
		_, e := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", seq, kind, jsonText(data))
		if e == nil {
			e = controller.Flush()
		}
		return e == nil
	}
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		rec, e := readResearchRecord(r.Context(), s.Store.DB, runID)
		if e != nil {
			return
		}
		s.researchEventsMu.Lock()
		events := []researchEvent{}
		if log := s.researchEvents[runID]; log != nil {
			events = append(events, log.events...)
		}
		s.researchEventsMu.Unlock()
		reset := after > rec.EventSequence || len(events) == 0 && rec.EventSequence > after || len(events) > 0 && after < events[0].Sequence-1
		if reset {
			if !send(rec.EventSequence, "reset", map[string]any{"run": rec.ResearchRun, "after": rec.EventSequence}) {
				return
			}
			after = rec.EventSequence
		}
		for _, event := range events {
			if event.Sequence > after {
				if !send(event.Sequence, event.Type, event.Data) {
					return
				}
				after = event.Sequence
			}
		}
		if rec.Status != "running" && rec.Status != "queued" {
			s.researchMu.Lock()
			worker := s.researchWorkers[runID]
			s.researchMu.Unlock()
			if worker != nil {
				select {
				case <-worker.done:
					continue
				case <-r.Context().Done():
					return
				}
			}
			if after == 0 || !reset && (len(events) == 0 || events[len(events)-1].Type != "done" && events[len(events)-1].Type != "error") {
				send(rec.EventSequence, "reset", map[string]any{"run": rec.ResearchRun})
			}
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}
