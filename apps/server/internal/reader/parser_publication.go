package reader

// Only publication holds the write lock: parsing, extraction, paid requests and
// full-file hashing must run before it. Scope commits hold a read lock through
// the short SQLite recheck/insert transaction, so a parser cannot publish in
// the gap between version validation and durable snapshot publication.
func (s *Server) beginParserPublication(documentID string) func() {
	s.parserPublicationMu.Lock()
	if s.parserGenerations == nil {
		s.parserGenerations = map[string]uint64{}
	}
	// Even a failed publication may have moved crops or other partial resources.
	s.parserGenerations[documentID]++
	return s.parserPublicationMu.Unlock
}
func (s *Server) parserGeneration(documentID string) uint64 {
	s.parserPublicationMu.RLock()
	defer s.parserPublicationMu.RUnlock()
	return s.parserGenerations[documentID]
}
