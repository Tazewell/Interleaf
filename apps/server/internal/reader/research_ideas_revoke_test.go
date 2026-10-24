package reader

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestResearchIdeasRemoteRevocationJoinsModel(t *testing.T) {
	for _, path := range []string{"explicit", "large"} {
		t.Run(path, func(t *testing.T) {
			s, topic, _ := noveltyFixture(t, "full")
			var calls atomic.Int32
			entered := make(chan struct{})
			release := make(chan struct{})
			canceled := make(chan struct{})
			var once, releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			defer unblock()
			var remote ResearchEvidence
			ideasModelRequestObserved(t, s, &calls, func(v *ResearchIdea) {
				v.Basis[0].EvidenceIDs = []string{remote.ID}
				v.NearestWorkIDs = []string{remote.CandidateID}
			}, func(ctx context.Context, text string) {
				_, raw, ok := strings.Cut(text, "RESEARCH_IDEA_EVIDENCE_JSON\n")
				if !ok {
					return
				}
				once.Do(func() {
					var ev []ResearchEvidence
					if err := json.Unmarshal([]byte(raw), &ev); err != nil {
						t.Error(err)
					}
					for _, item := range ev {
						if item.Kind == "remote-html" {
							remote = item
							break
						}
					}
					close(entered)
					select {
					case <-ctx.Done():
						close(canceled)
						<-release
					case <-release:
					}
				})
			})
			run := ideasRun(t, s, topic, "", ResearchRunInput{Network: "allow-task", URLs: []string{"http://paper.example/" + path}, IdeaCount: 1, Budget: ResearchBudget{MaxModelRequests: 2}})
			select {
			case <-entered:
			case <-time.After(30 * time.Second):
				t.Fatal("remote model not entered")
			}
			if remote.ID == "" {
				t.Fatal("remote source absent from actual model input")
			}
			rec, err := readResearchRecord(t.Context(), s.Store.DB, run)
			if err != nil {
				t.Fatal(err)
			}
			s.researchNetworkMu.Lock()
			owners := []*researchNetworkLease{}
			for owner := range s.researchNetworkOwners {
				if owner.sessionID == rec.SessionID {
					owners = append(owners, owner)
				}
			}
			s.researchNetworkMu.Unlock()
			successful := func() int {
				var n int
				err := s.Store.DB.QueryRow(`SELECT count(*) FROM research_units WHERE run_id=? AND status='complete' AND (kind='ideas' OR (kind='research-batch' AND json_extract(body,'$.result.progress.done')>0) OR (kind='network-plan' AND (unit_key='ideas-model' OR unit_key LIKE 'ideas-batch-model:%')))`, run).Scan(&n)
				if err != nil {
					t.Fatal(err)
				}
				return n
			}
			if n := successful(); n != 0 {
				t.Fatal("model response blocked but successful unit exists", n)
			}
			revoked := make(chan error, 1)
			go func() { revoked <- s.setResearchNetwork(t.Context(), rec.SessionID, false) }()
			select {
			case err = <-revoked:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("revoke did not join canceled stage")
			}
			requestCanceled := false
			select {
			case <-canceled:
				requestCanceled = true
			case <-time.After(time.Second):
			}
			for _, owner := range owners {
				select {
				case <-owner.done:
				default:
					t.Error("revoke returned before owner joined")
				}
			}
			unblock()
			// Wait for worker terminal state even on the pre-fix late-response path.
			terminal := false
			for until := time.Now().Add(5 * time.Second); time.Now().Before(until); {
				rec, err = readResearchRecord(t.Context(), s.Store.DB, run)
				if err != nil {
					t.Fatal(err)
				}
				if rec.Status != "running" && rec.Status != "queued" {
					terminal = true
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !terminal {
				t.Fatal("worker did not terminate")
			}
			out, err := s.getResearchResults(t.Context(), run)
			if err != nil {
				t.Fatal(err)
			}
			if len(owners) == 0 || !requestCanceled || successful() != 0 || len(out.PartialIdeas) != 0 || len(out.Ideas) != 0 {
				t.Fatalf("remote idea revoke failed: owners=%d requestCanceled=%v successful=%d partial=%d ideas=%d status=%s", len(owners), requestCanceled, successful(), len(out.PartialIdeas), len(out.Ideas), rec.Status)
			}
		})
	}
}

func TestResearchIdeasLocalDenyNeedsNoNetworkLease(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	var ideaCalls atomic.Int32
	ideasModelObserved(t, s, &calls, nil, func(text string) {
		if !strings.Contains(text, "RESEARCH_IDEA_EVIDENCE_JSON") {
			return
		}
		ideaCalls.Add(1)
		s.researchNetworkMu.Lock()
		n := len(s.researchNetworkOwners)
		s.researchNetworkMu.Unlock()
		if n != 0 {
			t.Error("local idea unexpectedly owns network lease")
		}
	})
	run := ideasRun(t, s, topic, "", ResearchRunInput{Network: "deny", IdeaCount: 1})
	researchWaitJob(t, s, run, "completed")
	out, err := s.getResearchResults(t.Context(), run)
	if err != nil || len(out.Ideas) != 1 || ideaCalls.Load() != 1 {
		t.Fatal(out, err, ideaCalls.Load())
	}
}
