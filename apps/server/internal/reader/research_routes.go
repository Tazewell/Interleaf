package reader

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

func (s *Server) registerResearchRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/research/runs/{run}/results", func(w http.ResponseWriter, r *http.Request) {
		results, err := s.getResearchResults(r.Context(), r.PathValue("run"))
		if err != nil {
			researchError(w, err)
			return
		}
		respond(w, 200, results)
	})
	mux.HandleFunc("PATCH /api/research/sessions/{session}/network", s.researchNetworkSettingHTTP)
	mux.HandleFunc("GET /api/research/topics/{topic}/candidates", s.researchCandidatesHTTP)
	mux.HandleFunc("GET /api/research/topics/{topic}/searches", s.researchSearchesHTTP)
	mux.HandleFunc("POST /api/research/topics/{topic}/candidates/{candidate}/import", s.researchCandidateImportHTTP)
	mux.HandleFunc("POST /api/research/topics/{topic}/sessions/{session}/runs", func(w http.ResponseWriter, r *http.Request) {
		var in ResearchRunInput
		if !decode(w, r, &in) {
			return
		}
		if s.researchRecoveryErr != nil {
			fail(w, 503, "研究任务恢复失败")
			return
		}
		run, err := s.createResearchRun(r.Context(), r.PathValue("topic"), r.PathValue("session"), in)
		if err != nil {
			// An empty identity means creation never reached the persistence phase.
			// Errors with an allocated/existing identity remain uncertain to clients.
			if run.ID == "" {
				respond(w, 400, map[string]string{"error": err.Error(), "code": "research_create_rejected"})
				return
			}
			researchError(w, err)
			return
		}
		respond(w, 201, run)
	})
	mux.HandleFunc("GET /api/research/runs/{run}", func(w http.ResponseWriter, r *http.Request) {
		run, err := s.getResearchRun(r.Context(), r.PathValue("run"))
		if err != nil {
			researchError(w, err)
			return
		}
		respond(w, 200, run)
	})
	for _, action := range []string{"start", "pause", "resume", "cancel"} {
		mux.HandleFunc("POST /api/research/runs/{run}/"+action, func(w http.ResponseWriter, r *http.Request) {
			var in ResearchControl
			if !decode(w, r, &in) {
				return
			}
			run, err := s.controlResearchRun(r.Context(), r.PathValue("run"), action, in)
			if err != nil {
				researchError(w, err)
				return
			}
			status := 200
			if run.Status == "running" || run.Status == "queued" {
				status = 202
			}
			respond(w, status, run)
		})
	}
	mux.HandleFunc("GET /api/research/runs/{run}/events", s.researchEventsHTTP)
	mux.HandleFunc("GET /api/research/reports/{report}", func(w http.ResponseWriter, r *http.Request) {
		report, err := readResearchReport(r.Context(), s.Store.DB, r.PathValue("report"))
		if err != nil {
			researchError(w, err)
			return
		}
		respond(w, 200, report)
	})
	mux.HandleFunc("GET /api/research/reports/{report}/markdown", func(w http.ResponseWriter, r *http.Request) {
		report, err := readResearchReport(r.Context(), s.Store.DB, r.PathValue("report"))
		if err != nil {
			researchError(w, err)
			return
		}
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="research-report.md"`)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write([]byte(s.researchMarkdown(r.Context(), report)))
	})
	mux.HandleFunc("POST /api/research/reports/{report}/revisions", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			RequestID string `json:"requestId"`
			Content   string `json:"content"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 6*researchReportBytes+1024))
		decoder.DisallowUnknownFields()
		var extra any
		if decoder.Decode(&in) != nil || decoder.Decode(&extra) != io.EOF {
			fail(w, 400, "无效的报告修订")
			return
		}
		report, err := s.createResearchReportRevision(r.Context(), r.PathValue("report"), in.RequestID, in.Content)
		if err != nil {
			researchError(w, err)
			return
		}
		respond(w, 201, report)
	})
	mux.HandleFunc("GET /api/research/topics/{topic}/reports", func(w http.ResponseWriter, r *http.Request) {
		if _, err := s.Store.ResearchTopic(r.Context(), r.PathValue("topic")); err != nil {
			researchError(w, err)
			return
		}
		rows, err := s.Store.DB.QueryContext(r.Context(), `SELECT body FROM research_reports WHERE topic_id=? ORDER BY created_at,id`, r.PathValue("topic"))
		if err != nil {
			researchError(w, err)
			return
		}
		defer rows.Close()
		out := []ResearchReport{}
		for rows.Next() {
			var raw string
			var report ResearchReport
			if rows.Scan(&raw) != nil || json.Unmarshal([]byte(raw), &report) != nil {
				fail(w, 500, "无法读取研究报告")
				return
			}
			out = append(out, report)
		}
		if rows.Err() != nil {
			fail(w, 500, "无法读取研究报告")
			return
		}
		respond(w, 200, out)
	})
	mux.HandleFunc("GET /api/research/sessions/{session}/messages", func(w http.ResponseWriter, r *http.Request) {
		if _, err := s.Store.ResearchSession(r.Context(), r.PathValue("session")); err != nil {
			researchError(w, err)
			return
		}
		rows, err := s.Store.DB.QueryContext(r.Context(), `SELECT m.body FROM research_messages m JOIN research_runs r ON r.id=m.run_id AND r.session_id=m.session_id WHERE m.session_id=? ORDER BY m.created_at,m.rowid`, r.PathValue("session"))
		if err != nil {
			researchError(w, err)
			return
		}
		defer rows.Close()
		out := []ResearchMessage{}
		for rows.Next() {
			var raw string
			var message ResearchMessage
			if rows.Scan(&raw) != nil || json.Unmarshal([]byte(raw), &message) != nil {
				fail(w, 500, "无法读取研究历史")
				return
			}
			out = append(out, message)
		}
		if rows.Err() != nil {
			fail(w, 500, "无法读取研究历史")
			return
		}
		respond(w, 200, out)
	})
	mux.HandleFunc("GET /api/research/sources/{source}", func(w http.ResponseWriter, r *http.Request) {
		ev, err := s.resolveResearchSource(r.Context(), r.PathValue("source"))
		if err != nil {
			fail(w, 409, "来源已失效或不可用")
			return
		}
		respond(w, 200, ev)
	})
	mux.HandleFunc("POST /api/research/topics", func(w http.ResponseWriter, r *http.Request) {
		var in ResearchTopicInput
		if !decode(w, r, &in) {
			return
		}
		t, err := s.Store.CreateResearchTopic(r.Context(), in)
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 201, t)
	})
	mux.HandleFunc("GET /api/research/topics", func(w http.ResponseWriter, r *http.Request) {
		topics, err := s.Store.ResearchTopics(r.Context())
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 200, topics)
	})
	mux.HandleFunc("GET /api/research/topics/{topic}", func(w http.ResponseWriter, r *http.Request) {
		t, err := s.Store.ResearchTopic(r.Context(), r.PathValue("topic"))
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 200, t)
	})
	mux.HandleFunc("PATCH /api/research/topics/{topic}", func(w http.ResponseWriter, r *http.Request) {
		var in ResearchTopicPatch
		if !decode(w, r, &in) {
			return
		}
		t, err := s.Store.UpdateResearchTopic(r.Context(), r.PathValue("topic"), in)
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 200, t)
	})
	mux.HandleFunc("POST /api/research/topics/{topic}/sessions", func(w http.ResponseWriter, r *http.Request) {
		var in ResearchSessionInput
		if !decode(w, r, &in) {
			return
		}
		session, err := s.Store.CreateResearchSession(r.Context(), r.PathValue("topic"), in)
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 201, session)
	})
	mux.HandleFunc("GET /api/research/topics/{topic}/sessions", func(w http.ResponseWriter, r *http.Request) {
		sessions, err := s.Store.ResearchSessions(r.Context(), r.PathValue("topic"))
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 200, sessions)
	})
}

func researchError(w http.ResponseWriter, err error) {
	if errors.Is(err, errResearchScopeChanged) {
		fail(w, 409, err.Error())
		return
	}
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "研究记录不存在")
		return
	}
	paperError(w, err)
}
