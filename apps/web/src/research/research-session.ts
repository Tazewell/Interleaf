import { researchAPI, RequestError } from "@reader/api";
import { researchDraftText } from "./research-draft";
import type {
  ResearchBudget,
  ResearchCandidate,
  ResearchMessage,
  ResearchReport,
  ResearchResults,
  ResearchRun,
  ResearchRunInput,
  ResearchSearch,
  ResearchSession,
  ResearchTopic,
} from "@reader/core";

export const researchBudget: ResearchBudget = {
  maxModelRequests: 200,
  maxSearchRequests: 24,
  maxRemoteReads: 8,
  maxMinutes: 30,
};
export const researchID = () => crypto.randomUUID().replaceAll("-", "");
export const running = (run?: ResearchRun) =>
  !!run && ["queued", "running"].includes(run.status);
let epoch = 0;
let lifetime = new AbortController();
const entries = new Map<string, ResearchStore>();
const epochListeners = new Set<() => void>();
const pendingOperations = new Map<string, { body: string; id: string }>();
type ReportEditor = {
  selected: string;
  editingId?: string;
  drafts: Map<string, { base: ResearchReport; content: string }>;
};
const reportEditors = new Map<string, ReportEditor>();
export function researchReportEditor(topicId: string, sessionId: string) {
  const key = JSON.stringify([topicId, sessionId]);
  let editor = reportEditors.get(key);
  if (!editor) {
    editor = { selected: "", drafts: new Map() };
    reportEditors.set(key, editor);
  }
  return editor;
}
export function researchOperationID(key: string, body = "") {
  const existing = pendingOperations.get(key);
  if (existing?.body === body) return existing.id;
  const id = researchID();
  pendingOperations.set(key, { body, id });
  return id;
}
export function finishResearchOperation(key: string, id: string) {
  if (pendingOperations.get(key)?.id === id) pendingOperations.delete(key);
}
export const researchEpoch = () => epoch;
export const researchSignal = () => lifetime.signal;
export const subscribeResearchEpoch = (listener: () => void) => {
  epochListeners.add(listener);
  return () => {
    epochListeners.delete(listener);
  };
};
export function resetResearchLibrary() {
  lifetime.abort();
  lifetime = new AbortController();
  ++epoch;
  for (const entry of entries.values()) entry.dispose();
  entries.clear();
  pendingOperations.clear();
  reportEditors.clear();
  for (const listener of epochListeners) listener();
}
export function researchStore(topicId: string) {
  let entry = entries.get(topicId);
  if (!entry) {
    entry = new ResearchStore(topicId);
    entries.set(topicId, entry);
  }
  return entry;
}
type SessionState = {
  messages: ResearchMessage[];
  run?: ResearchRun;
  draft: string;
  rawDraft: string;
  finalDelta: string;
  activity: string;
  results?: ResearchResults;
  error: string;
  busy: boolean;
  controlBusy?: boolean;
  networkBusy?: boolean;
  uncertain?: { userMessageId: string; question: string };
  rejectedDraft?: { question: string };
};
const emptySession = (): SessionState => ({
  run: undefined,
  results: undefined,
  uncertain: undefined,
  controlBusy: false,
  networkBusy: false,
  messages: [],
  draft: "",
  rawDraft: "",
  finalDelta: "",
  activity: "",
  error: "",
  busy: false,
});
export type ResearchState = SessionState & {
  topic?: ResearchTopic;
  sessions: ResearchSession[];
  sessionId: string;
  reports: ResearchReport[];
  candidates: ResearchCandidate[];
  searches: ResearchSearch[];
  loading: boolean;
};

class ResearchStore {
  private born = epoch;
  private listeners = new Set<() => void>();
  private sessions = new Map<string, SessionState>();
  private read?: AbortController;
  private stream?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private liveTimer?: ReturnType<typeof setTimeout>;
  private sequences = new Map<string, number>();
  private generations = new Map<string, number>();
  private sending = false;
  private controls = new Set<string>();
  private networks = new Set<string>();
  private busyFor(sid: string) {
    return this.sending || this.controls.has(sid) || this.networks.has(sid);
  }
  private readVersions = new Map<string, number>();
  private beginRead(sid: string, signal: AbortSignal) {
    const version = (this.readVersions.get(sid) ?? 0) + 1;
    this.readVersions.set(sid, version);
    const operation = this.generations.get(sid) ?? 0;
    return () =>
      this.valid() &&
      !signal.aborted &&
      this.state.sessionId === sid &&
      this.readVersions.get(sid) === version &&
      operation === (this.generations.get(sid) ?? 0);
  }
  private fenceLiveRead(sid: string) {
    clearTimeout(this.liveTimer);
    this.readVersions.set(sid, (this.readVersions.get(sid) ?? 0) + 1);
  }
  state: ResearchState = {
    ...emptySession(),
    sessions: [],
    sessionId: "",
    reports: [],
    candidates: [],
    searches: [],
    loading: true,
  };
  constructor(readonly topicId: string) {}
  snapshot = () => this.state;
  private valid() {
    return this.born === epoch && !lifetime.signal.aborted;
  }
  private patch(patch: Partial<ResearchState>) {
    if (!this.valid()) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private sessionPatch(sid: string, patch: Partial<SessionState>) {
    if (!this.valid()) return;
    const next = { ...(this.sessions.get(sid) ?? emptySession()), ...patch };
    this.sessions.set(sid, next);
    if (this.state.sessionId === sid) this.patch(next);
  }
  private accepts(run: ResearchRun, sid: string, runId?: string) {
    return (
      run.topicId === this.topicId &&
      run.sessionId === sid &&
      (!runId || run.id === runId)
    );
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.load();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.dispose();
    };
  };
  dispose() {
    this.read?.abort();
    this.stopStream();
  }
  private stopStream() {
    this.stream?.abort();
    this.stream = undefined;
    clearTimeout(this.timer);
    clearTimeout(this.liveTimer);
  }
  async load() {
    this.read?.abort();
    const controller = new AbortController();
    this.read = controller;
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    try {
      const [topic, sessions] = await Promise.all([
        researchAPI.getTopic(this.topicId, signal),
        researchAPI.listSessions(this.topicId, signal),
      ]);
      if (signal.aborted || topic.id !== this.topicId) return;
      const safe = sessions.filter((s) => s.topicId === this.topicId);
      this.patch({ topic, sessions: safe });
      const sid = safe.some((s) => s.id === this.state.sessionId)
        ? this.state.sessionId
        : (safe[safe.length - 1]?.id ?? "");
      await this.selectSession(sid);
    } catch (error) {
      if (!signal.aborted)
        this.patch({ error: String((error as Error).message), loading: false });
    }
  }
  async refresh(
    sid = this.state.sessionId,
    signal = lifetime.signal,
    owns = this.beginRead(sid, signal),
  ) {
    if (!owns()) return false;
    try {
      const [reports, candidates, searches, messages] = await Promise.all([
        researchAPI.listReports(this.topicId, signal),
        researchAPI.listCandidates(this.topicId, signal),
        researchAPI.listSearches(this.topicId, signal),
        sid ? researchAPI.listMessages(sid, signal) : Promise.resolve([]),
      ]);
      if (!owns()) return false;
      this.patch({
        reports: reports.filter((r) => r.topicId === this.topicId),
        candidates: candidates.filter((c) => c.topicId === this.topicId),
        searches,
      });
      if (sid)
        this.sessionPatch(sid, {
          messages: messages.filter((m) => m.sessionId === sid),
        });
      return true;
    } catch (error) {
      if (owns()) throw error;
      return false;
    }
  }
  async selectSession(sid: string) {
    this.stopStream();
    this.read?.abort();
    const controller = new AbortController();
    this.read = controller;
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    const operation = this.generations.get(sid) ?? 0;
    this.patch({
      sessionId: sid,
      ...(this.sessions.get(sid) ?? emptySession()),
      loading: true,
    });
    const owns = this.beginRead(sid, signal);
    try {
      if (!(await this.refresh(sid, signal, owns))) return;
      if (
        signal.aborted ||
        sid !== this.state.sessionId ||
        operation !== (this.generations.get(sid) ?? 0)
      )
        return;
      if (this.sessions.get(sid)?.uncertain) {
        await this.recover(sid);
        return;
      }
      const cached = this.sessions.get(sid)?.run;
      const runId =
        cached?.id ??
        [...this.state.messages].reverse().find((m) => m.runId)?.runId;
      if (runId && !(await this.query(sid, runId, signal, owns))) return;
      if (!signal.aborted) this.connect();
    } catch (error) {
      if (owns()) this.sessionPatch(sid, { error: (error as Error).message });
    } finally {
      if (!signal.aborted && sid === this.state.sessionId)
        this.patch({ loading: false });
    }
  }
  async newSession() {
    if (this.sending || this.state.busy) return;
    this.sending = true;
    this.patch({ busy: true, error: "" });
    const signal = lifetime.signal;
    try {
      const session = await researchAPI.createSession(
        this.topicId,
        { title: "新研究会话" },
        signal,
      );
      if (!this.valid() || signal.aborted || session.topicId !== this.topicId)
        return;
      this.patch({ sessions: [...this.state.sessions, session] });
      await this.selectSession(session.id);
    } catch (error) {
      this.patch({ error: (error as Error).message });
    } finally {
      this.sending = false;
      this.patch({ busy: false });
    }
  }
  async send(
    question: string,
    mode: ResearchRunInput["mode"],
    online = false,
    ideaId?: string,
  ) {
    if (
      this.sending ||
      this.state.busy ||
      this.state.uncertain ||
      running(this.state.run) ||
      ["preparing", "paused", "interrupted"].includes(
        this.state.run?.status ?? "",
      ) ||
      !question.trim()
    )
      return;
    this.sending = true;
    this.patch({ busy: true, error: "" });
    const signal = lifetime.signal;
    let sid = this.state.sessionId;
    let created: ResearchRun | undefined;
    const userMessageId = researchID();
    try {
      if (!sid) {
        const session = await researchAPI.createSession(
          this.topicId,
          { title: question.trim().slice(0, 60) },
          signal,
        );
        if (!this.valid() || session.topicId !== this.topicId) return;
        sid = session.id;
        this.patch({
          sessions: [...this.state.sessions, session],
          sessionId: sid,
        });
      }
      this.stopStream();
      this.generations.set(sid, (this.generations.get(sid) ?? 0) + 1);
      this.sessionPatch(sid, {
        busy: true,
        error: "",
        draft: "",
        rawDraft: "",
        finalDelta: "",
        activity: "",
        results: undefined,
        uncertain: { userMessageId, question: question.trim() },
        rejectedDraft: undefined,
        messages: [
          ...(this.sessions.get(sid)?.messages ?? []),
          {
            id: userMessageId,
            sessionId: sid,
            role: "user",
            content: question.trim(),
            createdAt: new Date().toISOString(),
          },
        ],
      });
      const urls = question.match(/https?:\/\/[^\s<>]+/g)?.slice(0, 8);
      created = await researchAPI.createRun(
        this.topicId,
        sid,
        {
          userMessageId,
          question: question.trim(),
          mode,
          ideaId,
          network: online ? "allow-task" : "inherit",
          budget: { ...researchBudget },
          ...(urls?.length ? { urls } : {}),
        },
        signal,
      );
      if (!this.valid() || !this.accepts(created, sid)) return;
      this.sessionPatch(sid, { run: created, uncertain: undefined });
      const started = await researchAPI.controlRun(
        created.id,
        "start",
        { requestId: researchID() },
        signal,
      );
      if (this.accepts(started, sid, created.id))
        this.sessionPatch(sid, { run: started });
      if (this.valid()) await this.recover(sid, created.id);
    } catch (error) {
      if (!this.valid()) return;
      if (created) await this.recover(sid, created.id);
      else if (error instanceof RequestError && error.status === 400 && error.code === "research_create_rejected") {
        this.sessionPatch(sid, {
          uncertain: undefined,
          rejectedDraft: { question: question.trim() },
          error: error.message,
          messages: (this.sessions.get(sid)?.messages ?? []).filter((message) => message.id !== userMessageId),
        });
      }
      else {
        // A lost create response may still have saved the user message and run.
        // Only read history; never repeat create/start to discover its identity.
        try {
          const found = await this.findCreatedRun(
            sid,
            userMessageId,
            question.trim(),
            signal,
          );
          if (found) {
            this.sessionPatch(sid, { run: found, uncertain: undefined });
            await this.recover(sid, found.id);
          } else
            this.sessionPatch(sid, {
              error: `创建结果未确认：${(error as Error).message}。请重试查询。`,
            });
        } catch (queryError) {
          this.sessionPatch(sid, {
            error: `查询失败：${(queryError as Error).message}`,
          });
        }
      }
    } finally {
      this.sending = false;
      this.sessionPatch(sid, { busy: this.busyFor(sid) });
    }
  }
  private async findCreatedRun(
    sid: string,
    userMessageId: string,
    question: string,
    signal: AbortSignal,
  ) {
    const messages = await researchAPI.listMessages(sid, signal);
    // Saved message IDs are allocated by the server. The client operation ID
    // lives on the run, so a same-text earlier question is never sufficient.
    const ids = [
      ...new Set(
        [...messages]
          .reverse()
          .filter(
            (message) =>
              message.sessionId === sid &&
              message.role === "user" &&
              message.content === question &&
              message.runId,
          )
          .map((message) => message.runId!),
      ),
    ];
    for (const id of ids) {
      const run = await researchAPI.getRun(id, signal);
      if (signal.aborted || !this.valid()) return;
      if (this.accepts(run, sid, id) && run.userMessageId === userMessageId)
        return run;
    }
  }
  private async query(
    sid: string,
    runId: string,
    signal: AbortSignal,
    owns: () => boolean,
  ) {
    if (!owns()) return false;
    try {
      const run = await researchAPI.getRun(runId, signal);
      if (!owns() || !this.accepts(run, sid, runId)) return false;
      this.sessionPatch(sid, { run, error: "" });
      const results = await researchAPI.getResults(runId, signal);
      if (!owns()) return false;
      this.sessionPatch(sid, { results });
      return true;
    } catch (error) {
      if (owns()) throw error;
      return false;
    }
  }
  async recover(
    sid = this.state.sessionId,
    runId = this.sessions.get(sid)?.run?.id,
  ) {
    const signal = lifetime.signal;
    const operation = this.generations.get(sid) ?? 0;
    const owns = this.beginRead(sid, signal);
    try {
      if (!owns()) return;
      const uncertain = this.sessions.get(sid)?.uncertain;
      if (uncertain) {
        const found = await this.findCreatedRun(
          sid,
          uncertain.userMessageId,
          uncertain.question,
          signal,
        );
        if (!owns()) return;
        if (!found) {
          this.sessionPatch(sid, {
            error: "创建结果仍未确认。请重试查询；不会自动重新提交。",
          });
          return;
        }
        runId = found.id;
        this.sessionPatch(sid, { run: found, uncertain: undefined });
      }
      if (runId && !(await this.query(sid, runId, signal, owns))) return;
      if (!this.valid() || operation !== (this.generations.get(sid) ?? 0))
        return;
      if (!(await this.refresh(sid, signal, owns))) return;
      if (!runId && sid === this.state.sessionId) {
        const found = [...this.state.messages]
          .reverse()
          .find((m) => m.runId)?.runId;
        if (found && !(await this.query(sid, found, signal, owns))) return;
      }
      if (
        operation === (this.generations.get(sid) ?? 0) &&
        sid === this.state.sessionId
      )
        this.connect();
    } catch (error) {
      if (owns())
        this.sessionPatch(sid, {
          error: `查询失败：${(error as Error).message}`,
        });
    }
  }
  async control(action: "pause" | "resume" | "cancel" | "start") {
    const { run, sessionId: sid, busy } = this.state;
    if (!run || this.controls.has(sid) || (busy && action !== "cancel")) return;
    this.controls.add(sid);
    this.sessionPatch(sid, { busy: true, controlBusy: true, error: "" });
    try {
      const next = await researchAPI.controlRun(
        run.id,
        action,
        {
          requestId: researchID(),
          ...(action === "resume" ? { budget: { ...researchBudget } } : {}),
        },
        lifetime.signal,
      );
      if (this.accepts(next, sid, run.id))
        this.sessionPatch(sid, { run: next });
      await this.recover(sid, run.id);
    } catch {
      await this.recover(sid, run.id);
    } finally {
      this.controls.delete(sid);
      this.sessionPatch(sid, { busy: this.busyFor(sid), controlBusy: false });
    }
  }
  async setNetwork(allowed: boolean) {
    const sid = this.state.sessionId;
    if (!sid || this.networks.has(sid) || (allowed && this.state.busy)) return;
    this.networks.add(sid);
    this.sessionPatch(sid, { busy: true, networkBusy: true, error: "" });
    try {
      await researchAPI.setNetwork(sid, allowed, lifetime.signal);
      this.patch({
        sessions: this.state.sessions.map((s) =>
          s.id === sid ? { ...s, networkAllowed: allowed } : s,
        ),
      });
      await this.recover(sid);
    } catch (error) {
      this.sessionPatch(sid, { error: (error as Error).message });
    } finally {
      this.networks.delete(sid);
      this.sessionPatch(sid, { busy: this.busyFor(sid), networkBusy: false });
    }
  }
  private connect() {
    this.stopStream();
    const { run, sessionId: sid } = this.state;
    if (!this.valid() || !this.listeners.size || !running(run)) return;
    const controller = new AbortController();
    this.stream = controller;
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    this.refreshWhileRunning(sid, run!.id, signal);
    void (async () => {
      let readOwns: (() => boolean) | undefined;
      try {
        const response = await researchAPI.events(
          run!.id,
          this.sequences.get(run!.id) ?? 0,
          signal,
        );
        if (!response.ok || !response.body)
          throw new Error("研究事件连接不可用");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!signal.aborted) {
            const chunk = await reader.read();
            buffer = (
              buffer + decoder.decode(chunk.value, { stream: !chunk.done })
            ).replace(/\r\n/g, "\n");
            let index: number;
            while ((index = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const lines = frame.split("\n");
              const id = Number(
                lines
                  .find((l) => l.startsWith("id:"))
                  ?.slice(3)
                  .trim(),
              );
              const kind = lines
                .find((l) => l.startsWith("event:"))
                ?.slice(6)
                .trim();
              const data = lines
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trimStart())
                .join("\n");
              if (
                !kind ||
                !data ||
                !Number.isSafeInteger(id) ||
                id < 0 ||
                signal.aborted
              )
                continue;
              if (kind !== "reset" && id <= (this.sequences.get(run!.id) ?? 0))
                continue;
              const payload = JSON.parse(data);
              this.sequences.set(
                run!.id,
                Math.max(id, this.sequences.get(run!.id) ?? 0),
              );
              if (payload.run && this.accepts(payload.run, sid, run!.id))
                this.sessionPatch(sid, { run: payload.run });
              const current = this.sessions.get(sid) ?? emptySession();
              if (kind === "delta") {
                const finalDelta = current.finalDelta + (payload.text ?? "");
                this.sessionPatch(sid, { finalDelta, draft: finalDelta });
              }
              if (kind === "draft") {
                const rawDraft =
                  (payload.reset ? "" : current.rawDraft) +
                  (payload.text ?? "");
                this.sessionPatch(sid, {
                  rawDraft,
                  draft: researchDraftText(rawDraft),
                });
              }
              if (kind === "activity")
                this.sessionPatch(sid, { activity: payload.message ?? "" });
              if (kind === "error" || kind === "done" || kind === "reset") {
                // Reset snapshots apply even at an already-seen terminal sequence.
                if (kind !== "reset" || !running(payload.run)) {
                  // A terminal event supersedes the whole older GET batch,
                  // before cancel()/recovery yields to any delayed response.
                  this.fenceLiveRead(sid);
                  await reader.cancel();
                  break;
                }
              }
            }
            if (chunk.done) break;
          }
        } finally {
          reader.releaseLock();
        }
        if (signal.aborted) return;
        this.fenceLiveRead(sid);
        readOwns = this.beginRead(sid, signal);
        if (!(await this.query(sid, run!.id, signal, readOwns))) return;
        if (!(await this.refresh(sid, signal, readOwns))) return;
        if (!signal.aborted && running(this.state.run))
          this.timer = setTimeout(() => this.connect(), 2000);
      } catch (error) {
        if (signal.aborted || (readOwns && !readOwns())) return;
        // Transport failure does not authorize another model call.
        try {
          this.fenceLiveRead(sid);
          readOwns = this.beginRead(sid, signal);
          if (!(await this.query(sid, run!.id, signal, readOwns))) return;
          if (!(await this.refresh(sid, signal, readOwns))) return;
        } catch (queryError) {
          if (readOwns?.())
            this.sessionPatch(sid, {
              error: `查询失败：${(queryError as Error).message}`,
            });
          return;
        }
        if (readOwns?.() && running(this.state.run))
          this.sessionPatch(sid, {
            error: `连接中断，请重试查询：${(error as Error).message}`,
          });
      }
    })();
  }
  private refreshWhileRunning(sid: string, runId: string, signal: AbortSignal) {
    const operation = this.generations.get(sid) ?? 0;
    const owns = () =>
      !signal.aborted &&
      this.valid() &&
      this.listeners.size > 0 &&
      this.state.sessionId === sid &&
      this.state.run?.id === runId &&
      operation === (this.generations.get(sid) ?? 0);
    const read = async () => {
      if (!owns()) return;
      const ownsBatch = this.beginRead(sid, signal);
      try {
        if (!(await this.query(sid, runId, signal, ownsBatch))) return;
        if (!(await this.refresh(sid, signal, ownsBatch))) return;
      } catch (error) {
        if (ownsBatch())
          this.sessionPatch(sid, {
            error: `查询失败：${(error as Error).message}`,
          });
      }
      // One bounded GET batch at a time, independent of the still-open SSE.
      // Never recover()/connect() here: polling cannot restart a subscription
      // or authorize another create/start/model operation.
      if (owns() && ownsBatch() && running(this.state.run))
        this.liveTimer = setTimeout(() => void read(), 3000);
    };
    this.liveTimer = setTimeout(() => void read(), 3000);
  }
}
