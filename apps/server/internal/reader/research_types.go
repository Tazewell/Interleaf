package reader

import "encoding/json"

type ResearchTopic struct {
	ID              string `json:"id"`
	Title           string `json:"title"`
	Folder          string `json:"folder"`
	IncludeChildren bool   `json:"includeChildren"`
	NetworkAllowed  bool   `json:"networkAllowed"`
	ScopeState      string `json:"scopeState"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
}
type ResearchMember struct {
	PaperID        string `json:"paperId"`
	DocumentID     string `json:"documentId,omitempty"`
	CitationKey    string `json:"citationKey"`
	Title          string `json:"title"`
	SourceHash     string `json:"sourceHash,omitempty"`
	CorpusRevision string `json:"corpusRevision,omitempty"`
	Coverage       string `json:"coverage"`
	Reason         string `json:"reason,omitempty"`
}
type ResearchSnapshot struct {
	ID        string           `json:"id"`
	TopicID   string           `json:"topicId"`
	Revision  string           `json:"revision"`
	Members   []ResearchMember `json:"members"`
	CreatedAt string           `json:"createdAt"`
}
type ResearchSession struct {
	ID             string `json:"id"`
	TopicID        string `json:"topicId"`
	Title          string `json:"title"`
	NetworkAllowed bool   `json:"networkAllowed"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}
type ResearchEvidence struct {
	ID           string          `json:"id"`
	TopicID      string          `json:"topicId"`
	SnapshotID   string          `json:"snapshotId"`
	RunID        string          `json:"runId"`
	PaperID      string          `json:"paperId,omitempty"`
	DocumentID   string          `json:"documentId,omitempty"`
	CandidateID  string          `json:"candidateId,omitempty"`
	Kind         string          `json:"kind"`
	Revision     string          `json:"revision"`
	ContentHash  string          `json:"contentHash"`
	Location     json.RawMessage `json:"location"`
	Excerpt      string          `json:"excerpt"`
	ReadAt       string          `json:"readAt"`
	Availability string          `json:"availability"`
}
type ResearchBudget struct {
	MaxModelRequests  int `json:"maxModelRequests"`
	MaxSearchRequests int `json:"maxSearchRequests"`
	MaxRemoteReads    int `json:"maxRemoteReads"`
	MaxMinutes        int `json:"maxMinutes"`
}
type ResearchRunInput struct {
	UserMessageID string         `json:"userMessageId"`
	Question      string         `json:"question"`
	Mode          string         `json:"mode"`
	IdeaID        string         `json:"ideaId,omitempty"`
	Network       string         `json:"network"`
	Budget        ResearchBudget `json:"budget"`
	URLs          []string       `json:"urls,omitempty"`
	IdeaCount     int            `json:"ideaCount,omitempty"`
}
type ResearchReadCoverage struct {
	// Native PDF pages / EPUB spine resources; abstract=1, metadata=0. A unit
	// completes only when all extractable text was provided. Images are separate.
	TotalUnits int               `json:"totalUnits"`
	ReadUnits  int               `json:"readUnits"`
	Ranges     []json.RawMessage `json:"ranges"`
}
type ResearchCoverage struct {
	TotalPapers        int                             `json:"totalPapers"`
	AnalyzedPapers     int                             `json:"analyzedPapers"`
	AbstractOnlyPapers int                             `json:"abstractOnlyPapers"`
	UnavailablePapers  int                             `json:"unavailablePapers"`
	PendingPapers      int                             `json:"pendingPapers"`
	ReadUnits          int                             `json:"readUnits"`
	TotalUnits         int                             `json:"totalUnits"`
	ReadCoverage       map[string]ResearchReadCoverage `json:"readCoverage"`
}
type ResearchRun struct {
	ID             string           `json:"id"`
	TopicID        string           `json:"topicId"`
	SessionID      string           `json:"sessionId"`
	UserMessageID  string           `json:"userMessageId"`
	Status         string           `json:"status"`
	Phase          string           `json:"phase"`
	SnapshotID     string           `json:"snapshotId"`
	Revision       string           `json:"revision"`
	Done           int              `json:"done"`
	Total          int              `json:"total"`
	Coverage       ResearchCoverage `json:"coverage"`
	Error          string           `json:"error,omitempty"`
	LimitReason    string           `json:"limitReason,omitempty"`
	LatestReportID string           `json:"latestReportId,omitempty"`
	UpdatedAt      string           `json:"updatedAt"`
}
type ResearchControl struct {
	RequestID string          `json:"requestId"`
	Budget    *ResearchBudget `json:"budget,omitempty"`
}
type ResearchReport struct {
	ID             string           `json:"id"`
	TopicID        string           `json:"topicId"`
	SessionID      string           `json:"sessionId"`
	RunID          string           `json:"runId,omitempty"`
	SourceRunID    string           `json:"sourceRunId,omitempty"`
	Kind           string           `json:"kind"`
	Revision       string           `json:"revision"`
	SourceRevision string           `json:"sourceRevision"`
	Origin         string           `json:"origin"`
	DerivedFromID  string           `json:"derivedFromId,omitempty"`
	Content        string           `json:"content"`
	SourceIDs      []string         `json:"sourceIds"`
	Coverage       ResearchCoverage `json:"coverage"`
	Stale          bool             `json:"stale"`
	CreatedAt      string           `json:"createdAt"`
}

// Each factual card field carries its own provenance, rather than treating the
// card-wide source list as evidence for every assertion.
type ResearchFact struct {
	Text        string   `json:"text"`
	EvidenceIDs []string `json:"evidenceIds"`
}
type ResearchPaperCard struct {
	CacheKey          string               `json:"cacheKey"`
	PaperID           string               `json:"paperId"`
	DocumentID        string               `json:"documentId,omitempty"`
	Revision          string               `json:"revision"`
	Level             string               `json:"level"`
	Problem           ResearchFact         `json:"problem"`
	Method            ResearchFact         `json:"method"`
	Assumptions       ResearchFact         `json:"assumptions"`
	DataAndEvaluation ResearchFact         `json:"dataAndEvaluation"`
	Findings          ResearchFact         `json:"findings"`
	Limitations       ResearchFact         `json:"limitations"`
	EvidenceIDs       []string             `json:"evidenceIds"`
	ReadCoverage      ResearchReadCoverage `json:"readCoverage"`
}
type ResearchSearch struct {
	ID           string          `json:"id"`
	RunID        string          `json:"runId"`
	Query        string          `json:"query"`
	Source       string          `json:"source"`
	Filters      json.RawMessage `json:"filters"`
	Status       string          `json:"status"`
	CandidateIDs []string        `json:"candidateIds"`
	FetchedAt    string          `json:"fetchedAt"`
	Error        string          `json:"error,omitempty"`
}
type ResearchCandidate struct {
	ID          string   `json:"id"`
	TopicID     string   `json:"topicId"`
	IdentityKey string   `json:"identityKey"`
	Title       string   `json:"title"`
	Authors     string   `json:"authors"`
	DOI         string   `json:"doi"`
	ArXiv       string   `json:"arxiv"`
	PublishedAt string   `json:"publishedAt"`
	UpdatedAt   string   `json:"updatedAt"`
	Abstract    string   `json:"abstract"`
	LandingURL  string   `json:"landingUrl"`
	PDFURL      string   `json:"pdfUrl"`
	Aliases     []string `json:"aliases"`
	PaperID     string   `json:"paperId,omitempty"`
	DocumentID  string   `json:"documentId,omitempty"`
}
type ResearchClaim struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}
type ResearchIdea struct {
	ID                string          `json:"id"`
	Problem           string          `json:"problem"`
	Mechanism         string          `json:"mechanism"`
	Hypotheses        []string        `json:"hypotheses"`
	Changes           []string        `json:"changes"`
	NearestWorkIDs    []string        `json:"nearestWorkIds"`
	MinimumExperiment string          `json:"minimumExperiment"`
	Baselines         []string        `json:"baselines"`
	Ablations         []string        `json:"ablations"`
	Falsification     string          `json:"falsification"`
	Resources         string          `json:"resources"`
	Claims            []ResearchClaim `json:"claims"`
}
type NoveltyRow struct {
	ClaimID        string   `json:"claimId"`
	Status         string   `json:"status"`
	RelatedWorkIDs []string `json:"relatedWorkIds"`
	EvidenceIDs    []string `json:"evidenceIds"`
	Overlap        string   `json:"overlap"`
	Difference     string   `json:"difference"`
	Unverified     string   `json:"unverified"`
}
type NoveltyReport struct {
	IdeaID   string           `json:"ideaId"`
	Rows     []NoveltyRow     `json:"rows"`
	QueryIDs []string         `json:"queryIds"`
	AsOf     string           `json:"asOf"`
	Coverage ResearchCoverage `json:"coverage"`
	Caveats  []string         `json:"caveats"`
}
type ResearchUnit struct {
	RunID       string          `json:"runId"`
	UnitKey     string          `json:"unitKey"`
	Kind        string          `json:"kind"`
	Status      string          `json:"status"`
	ContentHash string          `json:"contentHash"`
	Result      json.RawMessage `json:"result"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}
type ResearchConversation struct {
	SessionID     string            `json:"sessionId"`
	ConnectionKey string            `json:"connectionKey"`
	Revision      string            `json:"revision"`
	Messages      []json.RawMessage `json:"messages"`
}
type ResearchMessage struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	RunID     string `json:"runId,omitempty"`
	Role      string `json:"role"`
	Content   string `json:"content"`
	CreatedAt string `json:"createdAt"`
}
