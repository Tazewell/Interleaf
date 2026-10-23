package reader

import "net/http"

func (s *Server) registerResearchRoutes(mux *http.ServeMux) {
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
