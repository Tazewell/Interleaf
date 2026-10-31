// Shared research storage/wire entities. Keep synchronized with research_types.go.
import type { UsageCall } from "./index";
export interface ResearchTopic {
  id: string;
  title: string;
  folder: string;
  includeChildren: boolean;
  networkAllowed: boolean;
  scopeState: "active" | "detached";
  createdAt: string;
  updatedAt: string;
}

export interface ResearchMember {
  paperId: string;
  documentId?: string;
  citationKey: string;
  title: string;
  sourceHash?: string;
  corpusRevision?: string;
  coverage: "fulltext" | "abstract" | "metadata" | "unavailable";
  reason?: string;
}

export interface ResearchSnapshot {
  id: string;
  topicId: string;
  revision: string;
  members: ResearchMember[];
  createdAt: string;
}

export interface ResearchSession {
  networkGeneration?: number;
  id: string;
  topicId: string;
  title: string;
  networkAllowed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchEvidence {
  id: string;
  topicId: string;
  snapshotId: string;
  runId: string;
  paperId?: string;
  documentId?: string;
  candidateId?: string;
  kind:
    | "local-passage"
    | "local-page"
    | "remote-abstract"
    | "remote-html"
    | "remote-page";
  revision: string;
  contentHash: string;
  location: unknown;
  excerpt: string;
  readAt: string;
  availability: "valid" | "stale" | "removed";
}

export interface ResearchBudget {
  maxModelRequests: number;
  maxSearchRequests: number;
  maxRemoteReads: number;
  maxMinutes: number;
}

export interface ResearchRunInput {
  userMessageId: string;
  question: string;
  mode: "question" | "overview" | "compare" | "ideas" | "novelty";
  ideaId?: string;
  network: "inherit" | "allow-task" | "deny";
  budget: ResearchBudget;
  urls?: string[];
  ideaCount?: number;
}

export interface ResearchReadCoverage {
  /** Native PDF pages / EPUB spine resources; abstract=1, metadata=0.
   * A unit completes only after all extractable text was provided.
   * Exact partial ranges remain here; viewed images are separate. */
  totalUnits: number;
  readUnits: number;
  ranges: unknown[];
}

export interface ResearchCoverage {
  totalPapers: number;
  analyzedPapers: number;
  abstractOnlyPapers: number;
  unavailablePapers: number;
  pendingPapers: number;
  readUnits: number;
  totalUnits: number;
  readCoverage: Record<string, ResearchReadCoverage>;
}

export interface ResearchRun {
  usage?: ResearchUsage;
  id: string;
  topicId: string;
  sessionId: string;
  userMessageId: string;
  status:
    | "preparing"
    | "queued"
    | "running"
    | "paused"
    | "interrupted"
    | "completed"
    | "failed"
    | "canceled";
  phase: "snapshot" | "reading" | "searching" | "synthesizing" | "checking";
  snapshotId: string;
  revision: string;
  done: number;
  total: number;
  coverage: ResearchCoverage;
  error?: string;
  limitReason?: string;
  latestReportId?: string;
  updatedAt: string;
}
export interface ResearchUsage {
  attempt: number;
  attemptBudget: ResearchBudget;
  attemptRequests: number;
  modelRequests: number;
  calls: UsageCall[];
}

export interface ResearchControl {
  requestId: string;
  budget?: ResearchBudget;
}

export interface ResearchReport {
  id: string;
  topicId: string;
  sessionId: string;
  runId?: string;
  sourceRunId?: string;
  kind: string;
  revision: string;
  sourceRevision: string;
  origin: "model" | "user";
  derivedFromId?: string;
  content: string;
  sourceIds: string[];
  coverage: ResearchCoverage;
  stale: boolean;
  createdAt: string;
}

export interface ResearchFact {
  text: string;
  evidenceIds: string[];
}

export interface ResearchPaperCard {
  cacheKey: string;
  paperId: string;
  documentId?: string;
  revision: string;
  level: "fulltext" | "abstract" | "metadata";
  problem: ResearchFact;
  method: ResearchFact;
  assumptions: ResearchFact;
  dataAndEvaluation: ResearchFact;
  findings: ResearchFact;
  limitations: ResearchFact;
  evidenceIds: string[];
  readCoverage: ResearchReadCoverage;
}

export interface ResearchSearch {
  id: string;
  runId: string;
  query: string;
  source: string;
  filters: unknown;
  status: "ok" | "failed" | "limited";
  candidateIds: string[];
  fetchedAt: string;
  error?: string;
}

export interface ResearchCandidate {
  id: string;
  topicId: string;
  identityKey: string;
  title: string;
  authors: string;
  doi: string;
  arxiv: string;
  publishedAt: string;
  updatedAt: string;
  abstract: string;
  landingUrl: string;
  pdfUrl: string;
  aliases: string[];
  paperId?: string;
  documentId?: string;
}

export interface ResearchClaim {
  id: string;
  kind: "problem" | "method" | "experiment";
  text: string;
}

export interface ResearchIdea {
  basis: ResearchFact[];
  derivedFromId?: string;
  id: string;
  problem: string;
  mechanism: string;
  hypotheses: string[];
  changes: string[];
  nearestWorkIds: string[];
  minimumExperiment: string;
  baselines: string[];
  ablations: string[];
  falsification: string;
  resources: string;
  claims: ResearchClaim[];
}

export interface NoveltyRow {
  claimId: string;
  status: "high_overlap" | "partial_overlap" | "not_found" | "insufficient";
  relatedWorkIds: string[];
  evidenceIds: string[];
  overlap: string;
  difference: string;
  unverified: string;
}

export interface NoveltyReport {
  ideaId: string;
  rows: NoveltyRow[];
  queryIds: string[];
  asOf: string;
  coverage: ResearchCoverage;
  caveats: string[];
}

export interface ResearchUnit {
  runId: string;
  unitKey: string;
  kind: string;
  status: string;
  contentHash: string;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchConversation {
  sessionId: string;
  connectionKey: string;
  revision: string;
  messages: unknown[];
}

export interface ResearchMessage {
  id: string;
  sessionId: string;
  runId?: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ResearchTopicInput {
  title: string;
  folder: string;
  includeChildren?: boolean;
  networkAllowed?: boolean;
}

export interface ResearchTopicPatch {
  title?: string;
  folder?: string;
  includeChildren?: boolean;
  networkAllowed?: boolean;
}

export interface ResearchSessionInput {
  title: string;
}

export interface ResearchNoveltyQuery {
  ideaId: string;
  kind: "synonym" | "mechanism" | "adjacent";
  query: string;
  source: "arxiv" | "crossref";
  fromYear: number;
  toYear: number;
  searchId?: string;
  status: "pending" | "ok" | "failed" | "limited";
  fetchedAt?: string;
  exclusions: string[];
}
export interface ResearchBatchSourceProgress {
  sourceId: string;
  done: number;
  total: number;
}
export interface ResearchBatchProgress {
  stage: "ideas" | "novelty";
  ideaId?: string;
  claimId?: string;
  done: number;
  total: number;
  completedBatches: number;
  sources: ResearchBatchSourceProgress[];
}
export interface ResearchResults {
  partialIdeas: ResearchIdea[];
  batches: ResearchBatchProgress[];
  ideas: ResearchIdea[];
  novelty: NoveltyReport[];
  queries: ResearchNoveltyQuery[];
  pendingIdeaIds: string[];
  capability: "text-search-assistance";
}
