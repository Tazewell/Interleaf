import { useShortcut } from "./shortcuts/shortcuts";
import { usePaperUI } from "./papers/state";
import {
  SelectionTranslation,
  selectionTranslationKey,
} from "./SelectionTranslation";
import { isSelectionToolbar } from "./engines/selection-anchor";
import { LinkPreviewPanel } from "./LinkPreviewPanel";
import { AnnotationHoverCard } from "./AnnotationHoverCard";
import { AnnotationQuote } from "./AnnotationQuote";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type SetStateAction,
} from "react";
import {
  Translate as Languages,
  ChartBar as ChartColumn,
  ArrowLeft,
  BookOpen,
  SidebarSimple as PanelLeft,
  CaretLeft as ChevronLeft,
  CaretRight as ChevronRight,
  CaretDown as ChevronDown,
  MagnifyingGlass as Search,
  BookmarkSimple as BookmarkPlus,
  DotsThree as Ellipsis,
  Sparkle as Sparkles,
  GearSix as Settings2,
  TextUnderline as Underline,
  X,
  Note as StickyNote,
  Square,
  PaperPlaneTilt,
  Quotes as Quote,
  TextAa,
  HighlighterCircle as Highlighter,
  Check,
  Question as CircleHelp,
  ChatCircleDots,
  Lightbulb,
} from "@phosphor-icons/react";
import { api, blockImageURL } from "@interleaf/api";
import {
  locationLabel,
  type DocumentChatSession,
  type ChatSessionDeletion,
  type Annotation,
  type Document as ReaderDocument,
  type DocumentLocation,
  type ReaderAdapter,
  type ReaderSelection,
  type ReaderAnnotationTarget,
  type TOCItem,
  type SearchResult,
  type ReaderTheme,
  type Processing,
  type PDFBlock,
  type PDFBlockAction,
  type ImageAttachment,
  type LinkPreview,
  interleafLink,
} from "@interleaf/core";
import { Button } from "@interleaf/ui/components/button";
import { Badge } from "@interleaf/ui/components/badge";
import { Input } from "@interleaf/ui/components/input";
import { Textarea } from "@interleaf/ui/components/textarea";
import { SlidingTabsList } from "./controls/SlidingTabsList";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@interleaf/ui/components/tabs";
import { ScrollArea } from "@interleaf/ui/components/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@interleaf/ui/components/dropdown-menu";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@interleaf/ui/components/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@interleaf/ui/components/dialog";
import {
  ResizablePanelGroup,
  ResizablePanel,
  usePanelRef,
  ResizableHandle,
} from "@interleaf/ui/components/resizable";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@interleaf/ui/components/tooltip";
import { toast } from "sonner";
import { DocumentOverviewDialog } from "./DocumentOverview";
import { ProcessingUsageDialog } from "./ProcessingUsage";
import { ModelSelector } from "./ModelSelector";
import type { SettingsTarget } from "./Settings";
import { SourceReferences } from "./SourceReferences";
import { ChatSession } from "./chat/chat-session";
import { forgetChatSession, getChatSession } from "./chat/session-registry";
import { SessionPicker } from "./chat/SessionPicker";
import { AssistantPanel } from "./chat/AssistantPanel";
import { ImagePreview, imageLabel } from "./ImagePreview";
import { readingContext } from "./chat/reading-context";
import { referenceLabel } from "./references";
import { ReferenceNavigation } from "./reference-navigation";
import { SelectionToolbar } from "./SelectionToolbar";
import { AnnotationToolbar, annotationLabels } from "./AnnotationToolbar";
import { useAnnotationUndo } from "./useAnnotationUndo";
import { useAnnotationDeletion } from "./useAnnotationDeletion";
import {
  activeAnnotation,
  applySavedAnnotation,
  highlightPalette,
} from "./annotations";
import { ColorSwatchPicker } from "./ColorSwatches";
import { useSelectionClipboard } from "./useSelectionClipboard";
import { copyImage, copyText } from "./chat/clipboard";
import { NotesPanel } from "./NotesPanel";
import { ExportDocumentDialog } from "./ExportDocumentDialog";
import { EPUBReadingView } from "./translation/EPUBReadingView";
import { PDFReadingView } from "./translation/PDFReadingView";
import {
  activeHeading,
  headingOutline,
  pageOutline,
} from "./engines/pdf-outline";
import { useReaderSearch } from "./reader-search";
import { useReaderStore } from "./store";
import { scheduleProgress, flushProgress } from "./progress";
import { Slider } from "@interleaf/ui/components/slider";
import { Toggle } from "@interleaf/ui/components/toggle";
import { TranslationFontControls } from "./TranslationFontControls";

const maxDraftQuotes = 6;

function IconButton({
  label,
  children,
  onClick,
  active = false,
  expanded,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  expanded?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-expanded={expanded}
            data-active={active || undefined}
            className={active ? "toolbar-icon-active" : undefined}
            size="icon-sm"
            variant="ghost"
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
function TOCTree({
  items,
  go,
  location,
  active,
}: {
  items: TOCItem[];
  go: (location: DocumentLocation) => void;
  location?: DocumentLocation;
  active?: string;
}) {
  return (
    <div className="toc-tree">
      {items.map((item) => {
        const selected =
          active !== undefined
            ? item.id === active
            : item.location.type === location?.type &&
              (item.location.type === "pdf"
                ? item.location.page === (location as { page: number }).page
                : item.location.href.split("#")[0] ===
                  (location as { href: string }).href?.split("#")[0]);
        return (
          <div key={item.id} className="toc-node">
            <Button
              variant="ghost"
              className={`toc-item ${selected ? "selected" : ""}`}
              title={item.label}
              onClick={() => go(item.location)}
            >
              {item.children.length > 0 ? (
                <ChevronDown className="size-3 shrink-0" />
              ) : (
                <span className="toc-dot" />
              )}
              <span>{item.label}</span>
              {item.location.type === "pdf" && (
                <small>{item.location.page}</small>
              )}
            </Button>
            {item.children.length > 0 && (
              <div className="toc-children">
                <TOCTree
                  items={item.children}
                  go={go}
                  location={location}
                  active={active}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
export function Workspace({
  document: doc,
  theme,
  processing,
  onBack,
  originalTranslationRequest,
  onOriginalTranslationOpened,
  backLabel = "返回书库",
  onSettings,
}: {
  document: ReaderDocument;
  theme: ReaderTheme;
  processing?: Processing;
  originalTranslationRequest?: number;
  onOriginalTranslationOpened?: (sequence: number) => void;
  onBack: () => void;
  backLabel?: string;
  onSettings: (target?: SettingsTarget) => void;
}) {
  const { setTheme, aiConfig, setAIConfig, aiModelSaving } = useReaderStore();
  const translationSize = theme.translationFontSize ?? 1;
  const assistantSize = theme.assistantFontScale ?? 1;
  const linkTarget = useReaderStore((s) => s.linkTarget);
  const researchTarget = usePaperUI((s) => s.researchTarget);
  const [annotationsLoaded, setAnnotationsLoaded] = useState(false);
  const [blocks, setBlocks] = useState<PDFBlock[]>([]);
  const [readyReader, setReadyReader] = useState<{
    documentId: string;
    adapter: ReaderAdapter;
  }>();
  const adapter =
    readyReader?.documentId === doc.id ? readyReader.adapter : undefined;
  const [readingToolbar, setReadingToolbar] = useState<HTMLDivElement | null>(
    null,
  );
  const [sourceAutoCenterToolbar, setSourceAutoCenterToolbar] =
    useState<HTMLDivElement | null>(null);
  const renderBlockImage = useMemo(
    () => adapter?.renderBlockImage?.bind(adapter),
    [adapter],
  );
  const referenceNavigation = useMemo(
    () => new ReferenceNavigation(),
    [doc.id],
  );
  const [returnLocation, setReturnLocation] = useState<DocumentLocation>();
  const [linkPreview, setLinkPreview] = useState<LinkPreview | null>(null);
  const navigationRef = useRef<ReferenceNavigation | undefined>(
    referenceNavigation,
  );
  const [referenceBusy, setReferenceBusy] = useState(false);
  useLayoutEffect(() => {
    navigationRef.current = referenceNavigation;
    setReturnLocation(undefined);
    setReferenceBusy(false);
    return () => {
      referenceNavigation.setReader(undefined);
      navigationRef.current = undefined;
    };
  }, [referenceNavigation]);
  const finishReference = () => {
    if (navigationRef.current !== referenceNavigation) return;
    setReturnLocation(referenceNavigation.origin);
    setReferenceBusy(false);
  };
  const visitReference = async (target: DocumentLocation, text: string) => {
    if (!adapter || referenceNavigation.busy) return;
    setReferenceBusy(true);
    try {
      await referenceNavigation.visit(target, text);
    } finally {
      finishReference();
    }
  };
  const returnFromReference = async () => {
    if (referenceNavigation.busy) return;
    setReferenceBusy(true);
    try {
      await referenceNavigation.back();
    } catch (e) {
      if (navigationRef.current === referenceNavigation)
        toast.error((e as Error).message);
    } finally {
      finishReference();
    }
  };
  const [toc, setTOC] = useState<TOCItem[]>([]);
  const [location, setLocation] = useState<DocumentLocation | undefined>(
    doc.progress,
  );
  const latestLocation = useRef<DocumentLocation | undefined>(doc.progress);
  const sidebarTOC = useMemo(() => {
    if (doc.type !== "pdf" || !pageOutline(toc)) return toc;
    // Most PDFs ship without an embedded outline; parsed headings still give
    // a real table of contents, with the page list only as a last resort.
    const derived = headingOutline(blocks);
    return derived.length ? derived : toc;
  }, [doc.type, toc, blocks]);
  const activeTOC = useMemo(
    () =>
      doc.type === "pdf" && location?.type === "pdf"
        ? activeHeading(sidebarTOC, location.page)?.id
        : undefined,
    [doc.type, sidebarTOC, location],
  );
  const [translationRequest, setTranslationRequest] = useState<{
    selection: ReaderSelection;
    automatic: boolean;
  } | null>(null);
  const translationSelection = translationRequest?.selection ?? null;
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const activeSelection = selection ?? translationSelection;
  const closeSelectionUI = useCallback(() => {
    setSelection(null);
    setTranslationRequest(null);
    adapter?.clearSelection();
  }, [adapter]);
  useEffect(() => {
    if (
      theme.autoTranslateSelection === true &&
      selection?.anchor &&
      selection.text.trim()
    ) {
      const key = selectionTranslationKey(selection);
      setTranslationRequest((current) =>
        current && selectionTranslationKey(current.selection) === key
          ? current
          : { selection, automatic: true },
      );
    } else if (theme.autoTranslateSelection !== true) {
      setTranslationRequest((current) => (current?.automatic ? null : current));
    }
  }, [selection, theme.autoTranslateSelection]);
  const [annotations, replaceAnnotations] = useState<Annotation[]>([]);
  const deletedAnswerIds = useRef(new Set<string>());
  const annotationRevision = useRef(0);
  const setAnnotations = useCallback((next: SetStateAction<Annotation[]>) => {
    annotationRevision.current++;
    replaceAnnotations((items) =>
      (typeof next === "function" ? next(items) : next).map((item) => {
        if (!item.answerId || !deletedAnswerIds.current.has(item.answerId))
          return item;
        const { answerId: _deletedAnswer, ...annotation } = item;
        return annotation;
      }),
    );
  }, []);
  const recoveryDocument = useRef(doc.id);
  recoveryDocument.current = doc.id;
  const annotationSaving = useRef(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const selectionClipboard = useSelectionClipboard(theme.autoCopySelection);
  const [annotationTarget, setAnnotationTarget] =
    useState<ReaderAnnotationTarget | null>(null);
  const { deleting, remove: removeAnnotation } = useAnnotationDeletion(
    doc.id,
    (id) => {
      setAnnotations((items) => items.filter((item) => item.id !== id));
      setAnnotationTarget((target) => {
        if (!target) return null;
        const ids = target.ids.filter((item) => item !== id);
        return ids.length ? { ...target, ids } : null;
      });
    },
  );
  const [left, setLeft] = useState(true);
  const [right, setRight] = useState(true);
  const leftPanel = usePanelRef();
  const rightPanel = usePanelRef();
  const panelGroup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const group = panelGroup.current;
    const changes = [
      [leftPanel.current, left],
      [rightPanel.current, right],
    ] as const;
    if (
      !group ||
      !changes.some(([panel, open]) => panel && panel.isCollapsed() === open)
    )
      return;
    group.setAttribute("data-toggling", "");
    for (const [panel, open] of changes) {
      if (panel && panel.isCollapsed() === open) {
        if (open) panel.expand();
        else panel.collapse();
      }
    }
    const timer = setTimeout(() => group.removeAttribute("data-toggling"), 240);
    return () => {
      clearTimeout(timer);
      group.removeAttribute("data-toggling");
    };
  }, [left, right, leftPanel, rightPanel]);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [rightTab, setRightTab] = useState("ai");
  const [leftTab, setLeftTab] = useState("toc");
  const [query, setQuery] = useState("");
  const [searchScope, setSearchScope] = useState(0);
  const bumpSearchScope = useCallback(() => setSearchScope((scope) => scope + 1), []);
  const documentSearch = useReaderSearch(doc.id, adapter, searchScope);
  const { results, searchedQuery } = documentSearch;
  const searchInput = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteKind, setNoteKind] = useState<"note" | "question">("note");
  const palette = highlightPalette(useReaderStore((s) => s.theme));
  const [savedColor, setMarkColor] = useState<string>(() => {
    try {
      return localStorage.getItem("interleaf.mark-color") || "";
    } catch {
      return "";
    }
  });
  // The last color used, while it is still in the palette.
  const markColor = palette.some((c) => c.value === savedColor)
    ? savedColor
    : palette[0].value;
  const chooseColor = (color: string) => {
    setMarkColor(color);
    try {
      localStorage.setItem("interleaf.mark-color", color);
    } catch {
      /* the color only lasts for this session */
    }
  };
  const [answering, setAnswering] = useState<Set<string>>(new Set());
  const [exportingNotes, setExportingNotes] = useState(false);
  const [editingAnnotation, setEditingAnnotation] = useState<Annotation | null>(
    null,
  );
  const [noteSelection, setNoteSelection] = useState<ReaderSelection | null>(
    null,
  );
  const readingPane = useRef<HTMLDivElement>(null);
  const answerLookup = useRef<AbortController | null>(null);
  const [answerTarget, setAnswerTarget] = useState<{
    documentId: string;
    sessionId: string;
    messageId: string;
  }>();
  const [answerStatus, setAnswerStatus] = useState("");
  const clearAnswerTarget = useCallback(() => setAnswerTarget(undefined), []);
  const cancelAnswerNavigation = useCallback(() => {
    answerLookup.current?.abort();
    answerLookup.current = null;
    setAnswerTarget(undefined);
    setAnswerStatus("");
  }, []);
  useLayoutEffect(() => {
    cancelAnswerNavigation();
    return () => answerLookup.current?.abort();
  }, [doc.id, cancelAnswerNavigation]);
  useLayoutEffect(() => {
    if (!right) cancelAnswerNavigation();
  }, [right, cancelAnswerNavigation]);
  const [sessionCatalog, setSessionCatalog] = useState<{
    documentId: string;
    items: DocumentChatSession[];
  }>({ documentId: doc.id, items: [] });
  const [selectedSession, setSelectedSession] = useState<{
    documentId: string;
    id: string;
  }>({ documentId: doc.id, id: "" });
  const [sessionError, setSessionError] = useState("");
  const currentDocument = useRef(doc.id);
  currentDocument.current = doc.id;
  const sessions =
    sessionCatalog.documentId === doc.id ? sessionCatalog.items : [];
  let preferred =
    selectedSession.documentId === doc.id ? selectedSession.id : "";
  if (!preferred) {
    try {
      preferred =
        localStorage.getItem(`interleaf.chat-session.${doc.id}`) || "";
    } catch {}
  }
  const currentSession =
    sessions.find((s) => s.id === preferred) ?? sessions[0];
  const visibleSessions = useRef({
    documentId: doc.id,
    sessions,
    currentSession,
  });
  visibleSessions.current = { documentId: doc.id, sessions, currentSession };
  const deletedSessions = useRef(new Map<string, Set<string>>());
  const provider: string =
    aiConfig?.connection.url && !aiConfig.needsConfiguration ? "api" : "";
  const sessionListSerial = useRef(0);
  const refreshSessions = useCallback(async () => {
    const serial = ++sessionListSerial.current;
    const items = await api.chatSessions(doc.id, AbortSignal.timeout(15_000));
    const valid = items.filter(
      (item) => !deletedSessions.current.get(doc.id)?.has(item.id),
    );
    if (
      currentDocument.current === doc.id &&
      serial === sessionListSerial.current
    ) {
      setSessionCatalog({
        documentId: doc.id,
        items: valid,
      });
      setSessionError("");
    }
    return valid;
  }, [doc.id]);
  const selectSession = (id: string) => {
    setSelectedSession({ documentId: doc.id, id });
    try {
      localStorage.setItem(`interleaf.chat-session.${doc.id}`, id);
    } catch {}
  };
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refreshSessions();
      } catch (error) {
        if (alive) setSessionError((error as Error).message);
      } finally {
        if (alive) timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [refreshSessions]);
  const [prompt, setPrompt] = useState("");
  const [quotes, setQuotes] = useState<ReaderSelection[]>([]);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [previewImage, setPreviewImage] = useState<ImageAttachment>();
  const composeInput = useRef<HTMLTextAreaElement>(null);
  const openChatSettings = (section: SettingsTarget["section"]) =>
    onSettings({ section, returnFocus: composeInput.current });
  const composerDrafts = useRef(
    new Map<
      string,
      { prompt: string; quotes: ReaderSelection[]; images: ImageAttachment[] }
    >(),
  );
  const composerValue = useRef({ prompt, quotes, images });
  composerValue.current = { prompt, quotes, images };
  const composerKey = `${doc.id}:${currentSession?.id ?? ""}`;
  useEffect(() => {
    const saved = composerDrafts.current.get(composerKey);
    setPrompt(saved?.prompt ?? "");
    setQuotes(saved?.quotes ?? []);
    setImages(saved?.images ?? []);
    return () => {
      if (!deletedSessions.current.get(doc.id)?.has(currentSession?.id ?? ""))
        composerDrafts.current.set(composerKey, composerValue.current);
    };
  }, [composerKey]);
  const sessionDeleted = (id: string, result: ChatSessionDeletion) => {
    // Successful old-document mutations still release their own resources.
    // Their late response must never select a conversation in the new document.
    for (const messageId of forgetChatSession(doc.id, id))
      deletedAnswerIds.current.add(messageId);
    composerDrafts.current.delete(`${doc.id}:${id}`);
    const removed = deletedSessions.current.get(doc.id) ?? new Set<string>();
    removed.add(id);
    deletedSessions.current.set(doc.id, removed);
    try {
      const key = `interleaf.chat-session.${doc.id}`;
      if (localStorage.getItem(key) === id) localStorage.removeItem(key);
    } catch {}
    if (currentDocument.current !== doc.id) return;
    if (answerTarget?.sessionId === id) cancelAnswerNavigation();
    sessionListSerial.current++;
    const visible = visibleSessions.current;
    const remaining = visible.sessions.filter((item) => !removed.has(item.id));
    if (
      result.replacement &&
      !remaining.some((item) => item.id === result.replacement!.id)
    )
      remaining.push(result.replacement);
    setSessionCatalog({ documentId: doc.id, items: remaining });
    if (visible.currentSession?.id === id) {
      selectSession(remaining[0]?.id ?? "");
    }
    const unlinked = new Set(result.unlinkedAnnotationIds);
    if (unlinked.size)
      setAnnotations((items) =>
        items.map((item) => {
          if (!unlinked.has(item.id)) return item;
          if (item.answerId) deletedAnswerIds.current.add(item.answerId);
          const { answerId: _deletedAnswer, ...annotation } = item;
          return annotation;
        }),
      );
  };
  useEffect(() => {
    let alive = true;
    void api
      .aiConfig()
      .then((config) => {
        if (alive) setAIConfig(config);
      })
      .catch((error) => {
        if (alive) toast.error(error.message);
      });
    return () => {
      alive = false;
    };
  }, [setAIConfig]);
  const emptySession = useMemo(() => new ChatSession(doc.id), [doc.id]);
  const session = currentSession
    ? getChatSession(doc.id, currentSession.id)
    : emptySession;
  const chat = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const focusAnswerId =
    right &&
    rightTab === "ai" &&
    answerTarget?.documentId === doc.id &&
    answerTarget.sessionId === currentSession?.id
      ? answerTarget.messageId
      : undefined;
  useEffect(() => {
    if (
      !currentSession ||
      currentSession.latestRun?.status !== "running" ||
      chat.busy
    )
      return;
    const timer = setTimeout(() => void session.load(), 3000);
    return () => clearTimeout(timer);
  }, [
    currentSession?.latestRun?.id,
    currentSession?.latestRun?.status,
    chat.busy,
    session,
  ]);
  const sendSerial = useRef(0);
  const [preparing, setSending] = useState(false);
  const sending = preparing || chat.busy;
  const [pageDraft, setPageDraft] = useState<string>();
  const pageInput = pageDraft ?? (location?.type === "pdf" ? String(location.page) : "");
  const abort = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    setQuery("");
  }, [doc.id]);
  const updateReader = (engine?: ReaderAdapter, items?: TOCItem[]) => {
    if (navigationRef.current !== referenceNavigation) return;
    referenceNavigation.setReader(engine);
    setReadyReader(engine && { documentId: doc.id, adapter: engine });
    if (items) setTOC(items);
  };
  useShortcut("interleafLeft", () => setLeft((value) => !value));
  useShortcut("interleafRight", () => setRight((value) => !value));
  useShortcut("search", () => {
    setLeft(true);
    setLeftTab("search");
    requestAnimationFrame(() => searchInput.current?.focus());
  });
  useEffect(() => {
    session.activate();
    abort.current = null;
    if (currentSession) void session.load();
    setSending(false);
    return () => {
      sendSerial.current++;
      abort.current?.abort();
      // A viewer switch must not abort its independently owned run.
      void flushProgress().catch((e) => toast.error(e.message));
    };
  }, [doc.id, session]);
  const canRecoverAnnotations =
    processing?.status === "complete" && !processing.retranslating;
  useEffect(() => {
    let alive = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      let deferred = false;
      if (canRecoverAnnotations) {
        try {
          attempts++;
          const result = await api.recoverAnnotations(doc.id);
          deferred = !result.checked;
        } catch (e) {
          if (alive) toast.error((e as Error).message);
        }
      }
      if (!alive) return;
      try {
        const revision = annotationRevision.current;
        const items = await api.annotations(doc.id);
        if (alive) {
          // A background snapshot cannot overwrite a newer save/delete/undo.
          if (annotationRevision.current === revision) setAnnotations(items);
          setAnnotationsLoaded(true);
        }
      } catch (e) {
        if (alive) toast.error((e as Error).message);
      }
      // A transient snapshot/save lock must not turn opening a paper into an
      // error toast. Retry a bounded number of times without blocking its marks.
      if (alive && deferred && attempts < 3)
        timer = setTimeout(() => void load(), attempts * 1000);
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [doc.id, canRecoverAnnotations]);
  useEffect(() => {
    if (doc.type !== "pdf" || processing?.phase === "learning") return;
    let alive = true;
    void api
      .blocks(doc.id)
      .then((value) => {
        if (alive) setBlocks(value);
      })
      .catch((e) => toast.error(e.message));
    return () => {
      alive = false;
    };
  }, [
    doc.id,
    doc.type,
    processing?.phase,
    processing?.status,
    processing?.layoutRevision,
  ]);
  const move = (next: DocumentLocation) => {
    void adapter?.goTo(next).catch((e) => toast.error(e.message));
  };
  const openSourceLocation = (
    reader: ReaderAdapter,
    next: DocumentLocation,
  ) =>
    next.type === "pdf" && reader.focusLocation
      ? reader.focusLocation(next, "source")
      : reader.goTo(next);
  const focusAnnotation = (annotation: Annotation) => {
    const go = adapter?.focusLocation
      ? adapter.focusLocation(annotation.location)
      : adapter?.goTo(annotation.location);
    void go?.catch((e) => toast.error(e.message));
  };
  useEffect(() => {
    // Follow a interleaf:// link once the reader and annotations are ready.
    if (linkTarget?.id !== doc.id || !adapter || !annotationsLoaded) return;
    useReaderStore.getState().setLinkTarget(null);
    if (linkTarget.annotation) {
      const target = annotations.find((a) => a.id === linkTarget.annotation);
      if (target) {
        focusAnnotation(target);
        setRight(true);
        setRightTab("notes");
      } else toast.info("这条批注已不存在，已打开文档");
    } else if (linkTarget.page && doc.type === "pdf")
      void openSourceLocation(adapter, { type: "pdf", page: linkTarget.page })
        .catch((e) => toast.error(e.message));
  }, [linkTarget, adapter, annotationsLoaded, annotations, doc.id, doc.type]);
  useEffect(() => {
    if (!adapter || researchTarget?.documentId !== doc.id) return;
    usePaperUI.getState().setResearchTarget(null);
    if (researchTarget.location.type === doc.type)
      void openSourceLocation(adapter, researchTarget.location)
        .catch((error) => toast.error(error.message));
  }, [adapter, doc.id, doc.type, researchTarget]);
  const saveLocation = (next: DocumentLocation, percent: number) => {
    const previous = latestLocation.current;
    if (
      translationRequest &&
      JSON.stringify(next) !== JSON.stringify(previous)
    ) {
      setTranslationRequest(null);
    }
    latestLocation.current = next;
    // PDF chrome needs the page, not every subpixel scroll coordinate. Keep
    // precise progress in the ref for actions and persistence without
    // rerendering the reader and chat tree on every animation frame.
    if (
      next.type !== "pdf" ||
      previous?.type !== "pdf" ||
      next.page !== previous.page
    )
      setLocation(next);
    if (
      navigationRef.current === referenceNavigation &&
      referenceNavigation.settle()
    )
      setReturnLocation(undefined);
    scheduleProgress(doc.id, { progress: next, percentage: percent }, (e) =>
      toast.error(e.message),
    );
  };
  const annotate = async (
    kind: Annotation["kind"],
    noteText = "",
    color = markColor,
  ) => {
    const written = kind === "note" || kind === "question";
    const source = written ? noteSelection : activeSelection;
    const target =
      kind === "bookmark" ? latestLocation.current : source?.location;
    if (!target || annotationSaving.current) return;
    annotationSaving.current = true;
    setNoteSaving(written);
    try {
      const prepared =
        source && kind !== "bookmark" && !editingAnnotation
          ? ((await adapter?.prepareAnnotation?.(source)) ?? source)
          : source;
      const a =
        written && editingAnnotation
          ? await api.updateAnnotationNote(
              doc.id,
              editingAnnotation.id,
              noteText,
            )
          : await api.annotate(doc.id, {
              kind,
              location:
                kind === "bookmark" ? target : (prepared?.location ?? target),
              quote: kind === "bookmark" ? "" : source?.text || "",
              note: noteText,
              color,
            });
      setAnnotations((items) => applySavedAnnotation(items, a));
      setTranslationRequest(null);
      setSelection(null);
      adapter?.clearSelection();
      if (kind === "bookmark")
        toast.success("已添加书签", { id: "interleaf-annotation-save" });
      setNoteOpen(false);
      setNoteSelection(null);
      setEditingAnnotation(null);
      setNote("");
      return a;
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      annotationSaving.current = false;
      setNoteSaving(false);
    }
  };
  useAnnotationUndo(
    doc.id,
    (items) => {
      setAnnotations(items);
      setAnnotationTarget(null);
      setTranslationRequest(null);
      adapter?.clearSelection();
      setSelection(null);
    },
    () => !annotationsLoaded || annotationSaving.current || noteOpen,
  );

  const [hoveredAnnotation, setHoveredAnnotation] =
    useState<ReaderAnnotationTarget | null>(null);
  const selectedAnnotation = annotationTarget
    ? activeAnnotation(annotations, annotationTarget.ids)
    : undefined;
  const selectAnnotation = (target: ReaderAnnotationTarget | null) => {
    if (target) setTranslationRequest(null);
    setHoveredAnnotation(null);
    setAnnotationTarget(target);
    const annotation = target
      ? activeAnnotation(annotations, target.ids)
      : undefined;
    selectionClipboard.annotation(annotation);
  };
  const selectText = (next: ReaderSelection | null) => {
    if (next) {
      setHoveredAnnotation(null);
      setTranslationRequest((current) =>
        current &&
        selectionTranslationKey(current.selection) ===
          selectionTranslationKey(next)
          ? current
          : null,
      );
    } else {
      const node = window.getSelection()?.anchorNode;
      const selectedElement =
        node instanceof Element ? node : node?.parentElement;
      if (
        !isSelectionToolbar(document.activeElement) &&
        !isSelectionToolbar(selectedElement ?? null)
      ) {
        setTranslationRequest(null);
      }
    }
    setSelection(next);
    selectionClipboard.selection(next);
  };
  const editAnnotationNote = (annotation: Annotation) => {
    setHoveredAnnotation(null);
    setNoteKind(annotation.kind === "question" ? "question" : "note");
    setEditingAnnotation(annotation);
    setNoteSelection({ text: annotation.quote, location: annotation.location });
    setNote(annotation.note);
    setNoteOpen(true);
    setTranslationRequest(null);
    adapter?.clearSelection();
  };
  const quoteToChat = (quote: ReaderSelection) => {
    cancelAnswerNavigation();
    setQuotes((items) => {
      const remaining = items.filter(
        (item) =>
          item.text !== quote.text ||
          JSON.stringify(item.location) !== JSON.stringify(quote.location),
      );
      return remaining.length < maxDraftQuotes ? [...remaining, quote] : items;
    });
    setRight(true);
    setRightTab("ai");
    adapter?.clearSelection();
    setSelection(null);
    setTranslationRequest(null);
    setAnnotationTarget(null);
    setHoveredAnnotation(null);
    requestAnimationFrame(() => composeInput.current?.focus());
  };
  const quoteAnnotation = (annotation: Annotation) =>
    quoteToChat({ text: annotation.quote, location: annotation.location });
  const saveAnnotationText = async (
    annotation: Annotation,
    patch: { note: string; tags: string[] },
  ) => {
    try {
      const saved = await api.updateAnnotation(doc.id, annotation.id, patch);
      setAnnotations((items) => applySavedAnnotation(items, saved));
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };
  const recolor = async (annotation: Annotation, color: string) => {
    chooseColor(color);
    try {
      const saved = await api.updateAnnotation(doc.id, annotation.id, {
        color,
      });
      setAnnotations((items) => applySavedAnnotation(items, saved));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const resolveQuestion = async (annotation: Annotation, resolved: boolean) => {
    try {
      const saved = await api.updateAnnotation(doc.id, annotation.id, {
        resolved,
      });
      setAnnotations((items) => applySavedAnnotation(items, saved));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  /** Ask the AI and keep its saved answer linked to the question. */
  const answerQuestion = async (annotation: Annotation) => {
    if (answering.has(annotation.id)) return;
    setAnswering((ids) => new Set(ids).add(annotation.id));
    try {
      const answerId = await send(
        `请回答我在阅读时提出的问题：${annotation.note}\n回答时区分原文依据与你的推断。`,
        annotation.quote
          ? [{ text: annotation.quote, location: annotation.location }]
          : [],
        !annotation.quote,
      );
      if (!answerId) return;
      const saved = await api.updateAnnotation(doc.id, annotation.id, {
        answerId,
      });
      setAnnotations((items) => applySavedAnnotation(items, saved));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAnswering((ids) => {
        const next = new Set(ids);
        next.delete(annotation.id);
        return next;
      });
    }
  };
  const showAnswer = async (messageId: string) => {
    cancelAnswerNavigation();
    const openAnswer = (sessionId: string) => {
      if (visibleSessions.current.currentSession?.id !== sessionId)
        selectSession(sessionId);
      setAnswerTarget({ documentId: doc.id, sessionId, messageId });
      setAnswerStatus("");
      setRight(true);
      setRightTab("ai");
    };
    if (currentSession && chat.messages.some((message) => message.id === messageId)) {
      openAnswer(currentSession.id);
      return;
    }
    const controller = new AbortController();
    answerLookup.current = controller;
    const cancelled = () =>
      controller.signal.aborted || currentDocument.current !== doc.id;
    setAnswerStatus("正在查找回答…");
    try {
      const { sessionId } = await api.answerSession(
        doc.id,
        messageId,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      );
      if (cancelled()) return;
      const available = visibleSessions.current.sessions.some(
        (item) => item.id === sessionId,
      ) || (await refreshSessions()).some((item) => item.id === sessionId);
      if (cancelled()) return;
      if (!available || deletedSessions.current.get(doc.id)?.has(sessionId)) {
        setAnswerStatus("这条回答已不可用");
        return;
      }
      openAnswer(sessionId);
    } catch (error) {
      if (!cancelled()) setAnswerStatus((error as Error).message);
    } finally {
      if (answerLookup.current === controller) answerLookup.current = null;
    }
  };
  const openSearchResult = (result: SearchResult) => {
    documentSearch.select(result);
    const go = adapter?.focusLocation
      ? adapter.focusLocation(result.location, result.side)
      : adapter?.goTo(result.location);
    void go?.catch((error) => toast.error(error.message));
  };
  const addQuote = () => {
    if (activeSelection) quoteToChat(activeSelection);
  };
  const send = async (
    question = prompt,
    selected = quotes,
    useSection = false,
    attachments = images,
  ) => {
    if (abort.current || session.getSnapshot().busy || aiModelSaving) return;
    if (!question.trim()) return;
    cancelAnswerNavigation();
    if (!provider) {
      openChatSettings("connection");
      return;
    }
    if (!session.getSnapshot().loaded) {
      toast.error("对话记录尚未加载，请重新加载。");
      return;
    }
    setSending(true);
    setRight(true);
    setRightTab("ai");
    const controller = new AbortController();
    abort.current = controller;
    const serial = ++sendSerial.current;
    try {
      const captured = await readingContext(
        adapter,
        provider,
        selected,
        useSection,
        attachments.length > 0,
      );
      const { context } = captured;
      if (controller.signal.aborted || session.getSnapshot().busy) return;
      const response = session.send({
        provider,
        prompt: question,
        context,
        references: captured.references,
        readingLocation: captured.readingLocation,
        attachments,
      });
      // The session owns its captured input as soon as generation starts.
      // Leave the composer ready for the next question independently of how
      // long the answer takes or whether its completion can be confirmed.
      if (session.getSnapshot().busy) {
        setPrompt((current) => (current === question ? "" : current));
        setQuotes((current) =>
          current.filter((quote) => !selected.includes(quote)),
        );
        setImages((current) =>
          current.filter((image) => !attachments.includes(image)),
        );
      }
      await response;
      if (serial !== sendSerial.current) return;
      const answer = session.getSnapshot().pending;
      return answer?.phase === "saved" ? answer.savedId : undefined;
    } catch (e) {
      if (serial === sendSerial.current && (e as Error).name !== "AbortError")
        toast.error((e as Error).message);
    } finally {
      if (serial === sendSerial.current) {
        setSending(false);
        abort.current = null;
      }
    }
  };
  const regenerate = async () => {
    const current = useReaderStore.getState();
    if (abort.current || session.getSnapshot().busy || current.aiModelSaving)
      return;
    if (!provider) {
      openChatSettings("connection");
      return;
    }
    const serial = ++sendSerial.current;
    setSending(true);
    try {
      await session.regenerate(provider);
    } catch (error) {
      if (serial === sendSerial.current) toast.error((error as Error).message);
    } finally {
      if (serial === sendSerial.current) setSending(false);
    }
  };
  const blockAction = (block: PDFBlock, action: PDFBlockAction) => {
    if (action === "copy") {
      if (block.image)
        void copyImage(
          blockImageURL(doc.id, block.id, block.image),
          (block.caption || block.text).trim(),
        );
      else void copyText(block.text.trim(), "已复制");
      return;
    }
    if (!block.image) {
      if (action === "attach" || action === "explain")
        quoteToChat({
          text: block.text,
          location: {
            type: "pdf",
            page: block.page,
            quote: block.text,
            rects: [block.bounds],
          },
        });
      return;
    }
    const image: ImageAttachment = {
      id: block.id,
      page: block.page,
      label: block.label,
      caption: block.caption,
    };
    if (action === "preview") {
      setPreviewImage(image);
      return;
    }
    if (action !== "attach" && action !== "explain") return;
    cancelAnswerNavigation();
    setRight(true);
    setRightTab("ai");
    requestAnimationFrame(() => composeInput.current?.focus());
    if (images.some((item) => item.id === image.id)) return;
    if (images.length >= 4) {
      toast.info("每次最多附加 4 张图片");
      return;
    }
    setImages((current) => [...current, image]);
  };
  const imageAttachments = (items: ImageAttachment[], removable = false) => (
    <div className="image-attachments">
      {items.map((image) => (
        <div key={image.id} className="image-attachment">
          <Button
            className="attachment-preview"
            variant="ghost"
            aria-label={`查看附件：${imageLabel(image)}`}
            onClick={() => setPreviewImage(image)}
          >
            <img
              src={blockImageURL(doc.id, image.id)}
              alt={imageLabel(image)}
            />
            <span>{imageLabel(image)}</span>
          </Button>
          {removable && (
            <Button
              className="attachment-remove"
              variant="ghost"
              size="icon-xs"
              aria-label={`移除附件：${imageLabel(image)}`}
              onClick={() =>
                setImages((current) =>
                  current.filter((item) => item.id !== image.id),
                )
              }
            >
              <X />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
  const pageNavigation = (
    <div className="page-navigation">
      <IconButton
        label="上一页"
        onClick={() =>
          void adapter?.previous().catch((e) => toast.error(e.message))
        }
      >
        <ChevronLeft />
      </IconButton>
      {doc.type === "pdf" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const page = Number(pageInput);
            if (Number.isInteger(page) && page > 0) {
              setPageDraft(undefined);
              move({ type: "pdf", page });
            }
          }}
        >
          <Input
            aria-label="跳转 PDF 页码"
            value={pageInput}
            inputMode="numeric"
            onChange={(e) => setPageDraft(e.target.value)}
            onBlur={() => setPageDraft(undefined)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setPageDraft(undefined);
            }}
            className="h-7 w-14 text-center"
          />
        </form>
      ) : null}
      <IconButton
        label="下一页"
        onClick={() =>
          void adapter?.next().catch((e) => toast.error(e.message))
        }
      >
        <ChevronRight />
      </IconButton>
    </div>
  );
  return (
    <div className="workspace">
      <header className="interleaf-toolbar">
        <div className="interleaf-title-group">
          <IconButton
            label={backLabel}
            onClick={() => {
              void flushProgress()
                .then(onBack)
                .catch((e) => toast.error(e.message));
            }}
          >
            <ArrowLeft />
          </IconButton>
          <IconButton
            label="目录与搜索"
            active={left}
            expanded={left}
            onClick={() => setLeft(!left)}
          >
            <PanelLeft />
          </IconButton>
          <span className="interleaf-title" title={doc.title}>
            {doc.title}
          </span>
          <Badge variant="secondary">{doc.type.toUpperCase()}</Badge>
        </div>
        <div className="toolbar-actions">
          {returnLocation && (
            <Button
              variant="outline"
              size="sm"
              disabled={!adapter || referenceBusy}
              onClick={() => void returnFromReference()}
            >
              <ArrowLeft className="size-3" />
              返回阅读位置
            </Button>
          )}
          <div ref={setSourceAutoCenterToolbar} />
          <Popover>
            <PopoverTrigger
              render={
                <Button size="icon-sm" variant="ghost" aria-label="阅读外观" />
              }
            >
              <TextAa />
            </PopoverTrigger>
            <PopoverContent className="appearance-panel w-80 gap-0 p-0">
              <div className="appearance-header">
                <h3>阅读外观</h3>
              </div>
              <div className="appearance-section">
                <span className="appearance-section-title">配色</span>
                <Tabs
                  value={
                    theme.mode === "dark"
                      ? theme.pdfDarkContrast === "high"
                        ? "dark"
                        : "gray"
                      : theme.mode
                  }
                  onValueChange={(value) => {
                    if (!value) return;
                    const mode =
                      value === "gray"
                        ? "dark"
                        : (value as "light" | "sepia" | "dark");
                    setTheme({
                      mode,
                      appearance: mode,
                      ...(mode === "dark"
                        ? {
                            pdfDarkContrast: value === "gray" ? "soft" : "high",
                          }
                        : {}),
                    });
                  }}
                >
                  <SlidingTabsList className="w-full" aria-label="阅读配色">
                    <TabsTrigger value="light">浅色</TabsTrigger>
                    <TabsTrigger value="dark">深色</TabsTrigger>
                    <TabsTrigger value="sepia">纸张</TabsTrigger>
                    <TabsTrigger value="gray">灰色</TabsTrigger>
                  </SlidingTabsList>
                </Tabs>
              </div>
              <div className="appearance-section">
                <div className="appearance-section-head">
                  <span className="appearance-section-title">原文</span>
                  {doc.type === "pdf" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        adapter?.exitBlockFocus?.();
                        setTheme({ zoom: "width" });
                      }}
                    >
                      适宽
                    </Button>
                  ) : null}
                </div>
                {doc.type === "epub" ? (
                  <>
                    <div className="appearance-row">
                      <span>字号</span>
                      <div className="appearance-stepper">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="减小字号"
                          onClick={() =>
                            setTheme({
                              fontSize: Math.max(0.8, theme.fontSize - 0.1),
                            })
                          }
                        >
                          −
                        </Button>
                        <span className="appearance-value">
                          {Math.round(theme.fontSize * 100)}%
                        </span>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="增大字号"
                          onClick={() =>
                            setTheme({
                              fontSize: Math.min(2.4, theme.fontSize + 0.1),
                            })
                          }
                        >
                          +
                        </Button>
                      </div>
                    </div>
                    <div className="appearance-row">
                      <span>行距</span>
                      <div className="appearance-stepper">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="减小行距"
                          onClick={() =>
                            setTheme({
                              lineHeight: Math.max(
                                1.2,
                                Math.round((theme.lineHeight - 0.2) * 10) / 10,
                              ),
                            })
                          }
                        >
                          −
                        </Button>
                        <span className="appearance-value">
                          {theme.lineHeight.toFixed(1)}
                        </span>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="增大行距"
                          onClick={() =>
                            setTheme({
                              lineHeight: Math.min(
                                2.4,
                                Math.round((theme.lineHeight + 0.2) * 10) / 10,
                              ),
                            })
                          }
                        >
                          +
                        </Button>
                      </div>
                    </div>
                    <div className="appearance-row">
                      <span>页边距</span>
                      <div className="appearance-stepper">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="减小页边距"
                          onClick={() =>
                            setTheme({
                              margin: Math.max(16, theme.margin - 16),
                            })
                          }
                        >
                          −
                        </Button>
                        <span className="appearance-value">{theme.margin}</span>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="增大页边距"
                          onClick={() =>
                            setTheme({
                              margin: Math.min(64, theme.margin + 16),
                            })
                          }
                        >
                          +
                        </Button>
                      </div>
                    </div>
                    <div className="appearance-row">
                      <span>字体</span>
                      <Toggle
                        size="sm"
                        variant="outline"
                        className="text-xs font-normal"
                        pressed={theme.fontFamily === "serif"}
                        onPressedChange={(pressed) =>
                          setTheme({
                            fontFamily: pressed ? "serif" : "sans-serif",
                          })
                        }
                      >
                        {theme.fontFamily === "serif"
                          ? "宋体 / 衬线"
                          : "黑体 / 无衬线"}
                      </Toggle>
                    </div>
                  </>
                ) : (
                  <div className="appearance-slider-row">
                    <span>缩放</span>
                    <Slider
                      className="reading-appearance-slider min-w-0"
                      thumbLabel="原文缩放"
                      min={50}
                      max={300}
                      step={5}
                      value={[
                        typeof theme.zoom === "number"
                          ? Math.round(theme.zoom * 100)
                          : 100,
                      ]}
                      onValueChange={(value) =>
                        setTheme({
                          zoom: (Array.isArray(value) ? value[0] : value) / 100,
                        })
                      }
                    />
                    <span className="appearance-value text-right">
                      {typeof theme.zoom === "number"
                        ? `${Math.round(theme.zoom * 100)}%`
                        : "自动"}
                    </span>
                  </div>
                )}
              </div>
              <div className="appearance-section">
                <span className="appearance-section-title">译文</span>
                <div className="appearance-slider-row">
                  <span>字号</span>
                  <Slider
                    className="reading-appearance-slider min-w-0"
                    thumbLabel="译文字号"
                    min={80}
                    max={160}
                    step={5}
                    value={[Math.round(translationSize * 100)]}
                    onValueChange={(value) =>
                      setTheme({
                        translationFontSize:
                          (Array.isArray(value) ? value[0] : value) / 100,
                      })
                    }
                  />
                  <span className="appearance-value text-right">
                    {Math.round(translationSize * 100)}%
                  </span>
                </div>
                <TranslationFontControls theme={theme} setTheme={setTheme} />
              </div>
              <div className="appearance-section">
                <span className="appearance-section-title">对话</span>
                <div className="appearance-slider-row">
                  <span>字号</span>
                  <Slider
                    className="reading-appearance-slider min-w-0"
                    thumbLabel="Agent 字号"
                    min={80}
                    max={160}
                    step={5}
                    value={[Math.round(assistantSize * 100)]}
                    onValueChange={(value) =>
                      setTheme({
                        assistantFontScale:
                          (Array.isArray(value) ? value[0] : value) / 100,
                      })
                    }
                  />
                  <span className="appearance-value text-right">
                    {Math.round(assistantSize * 100)}%
                  </span>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <IconButton
            label={right ? "收起右侧栏" : "展开右侧栏"}
            active={right}
            expanded={right}
            onClick={() => setRight(!right)}
          >
            <PanelLeft className="rotate-180" />
          </IconButton>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="更多阅读操作"
                  title="更多阅读操作"
                />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => void annotate("bookmark")}>
                <BookmarkPlus />
                添加书签
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSettings()}>
                <Settings2 />
                设置
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <ResizablePanelGroup
        orientation="horizontal"
        className="interleaf-panels"
        elementRef={panelGroup}
        onLayoutChanged={(layout, { isUserInteraction }) => {
          if (isUserInteraction) {
            setLeft(layout.navigation > 0);
            setRight(layout.assistant > 0);
          }
        }}
        onPointerDownCapture={(event) => {
          if (
            (event.target as Element).closest('[data-slot="resizable-handle"]')
          )
            panelGroup.current?.removeAttribute("data-toggling");
        }}
      >
        <ResizablePanel
          id="navigation"
          panelRef={leftPanel}
          collapsible
          collapsedSize={0}
          style={{ overflow: "hidden" }}
          defaultSize="13%"
          minSize="140px"
          maxSize="30%"
        >
          <aside className="interleaf-sidebar" data-open={left} inert={!left}>
            <Tabs
              value={leftTab}
              onValueChange={(value) => setLeftTab(String(value))}
              className="h-full gap-0"
            >
              <div className="panel-header reader-navigation-header">
                <TabsList
                  className="panel-tabs reader-navigation-tabs"
                  aria-label="阅读导航"
                >
                  <TabsTrigger value="toc" className="reader-navigation-title">
                    目录
                  </TabsTrigger>
                  <TabsTrigger
                    value="search"
                    className="reader-navigation-search"
                    aria-label="搜索文档内容"
                  >
                    <Search className="size-3.5" />
                    <span className="sr-only">搜索</span>
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="toc" className="min-h-0 flex-1">
                <ScrollArea className="h-full">
                  <TOCTree
                    items={sidebarTOC}
                    active={activeTOC}
                    go={move}
                    location={location}
                  />
                  {!sidebarTOC.length && (
                    <p className="p-4 text-xs text-muted-foreground">
                      正在读取目录…
                    </p>
                  )}
                </ScrollArea>
              </TabsContent>
              <TabsContent value="search" className="min-h-0 flex-1 p-3">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    documentSearch.submit(query);
                  }}
                  className="flex gap-1"
                >
                  <Input
                    aria-label="搜索文档"
                    ref={searchInput}
                    placeholder="搜索文档内容…"
                    value={query}
                    onChange={(e) => {
                      documentSearch.clear();
                      setQuery(e.target.value);
                    }}
                  />
                  <Button
                    size="icon"
                    type="submit"
                    variant="secondary"
                    disabled={
                      !adapter || !query.trim() || documentSearch.status === "searching"
                    }
                    aria-label="搜索"
                  >
                    <Search />
                  </Button>
                </form>
                <p className="my-3 text-xs text-muted-foreground" role="status">
                  {documentSearch.status === "searching"
                    ? "正在搜索…"
                    : documentSearch.status === "waiting"
                      ? "等待阅读器就绪…"
                      : documentSearch.status === "error"
                        ? "搜索失败，请重试。" + (documentSearch.error ? " " + documentSearch.error : "")
                        : documentSearch.status === "complete"
                          ? results.length + " 个结果"
                          : "输入关键词，搜索当前文档。"}
                </p>
                <ScrollArea className="h-[calc(100%-90px)]">
                  {results.map((result) => (
                    <Button
                      key={result.id}
                      variant={documentSearch.selectedId === result.id ? "secondary" : "ghost"}
                      aria-current={documentSearch.selectedId === result.id || undefined}
                      className="search-result"
                      onClick={() => openSearchResult(result)}
                    >
                      <small>
                        {locationLabel(result.location)}
                        {result.side === "translation"
                          ? " · 译文"
                          : result.side === "source"
                            ? " · 原文"
                            : ""}
                      </small>
                      <span>{result.excerpt}</span>
                    </Button>
                  ))}
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </aside>
        </ResizablePanel>
        <ResizableHandle
          disabled={!left}
          className={`reader-navigation-resizer${left ? "" : " sidebar-handle-closed"}`}
        />
        <ResizablePanel id="reading" minSize="30%">
          <div
            className="reading-pane"
            data-assistant-open={right}
            ref={readingPane}
          >
            <div className="reading-toolbar-host" ref={setReadingToolbar} />
            {(() => {
              const ReadingView =
                doc.type === "pdf" ? PDFReadingView : EPUBReadingView;
              return (
                <ReadingView
                  sidebarsOpen={{ left, right }}
                  document={doc}
                  theme={theme}
                  annotations={annotations}
                  blocks={blocks}
                  processing={processing}
                  {...(doc.type === "pdf" && {
                    originalTranslationRequest,
                    onOriginalTranslationOpened,
                  })}
                  translationSetup={
                    aiConfig && {
                      connectionRequired: !provider,
                      open: (section, returnFocus) =>
                        onSettings({ section, returnFocus }),
                    }
                  }
                  toolbarHost={readingToolbar}
                  autoCenterHost={sourceAutoCenterToolbar}
                  pageNavigation={pageNavigation}
                  searchResults={results}
                  searchQuery={searchedQuery}
                  onSearchScopeChanged={bumpSearchScope}
                  onReady={updateReader}
                  onAdapterDetached={updateReader}
                  events={{
                    zoom: (zoom) => setTheme({ zoom }),
                    location: saveLocation,
                    selection: selectText,
                    annotation: selectAnnotation,
                    annotationHover: (target) =>
                      setHoveredAnnotation((current) =>
                        current &&
                        target &&
                        current.ids.join(",") === target.ids.join(",")
                          ? current
                          : target,
                      ),
                    linkPreview: setLinkPreview,
                    internalLink: (origin) => {
                      if (navigationRef.current !== referenceNavigation) return;
                      referenceNavigation.remember(origin);
                      setReturnLocation(referenceNavigation.origin);
                    },
                    blockAction,
                  }}
                />
              );
            })()}
            {!activeSelection && annotationTarget && selectedAnnotation && (
              <AnnotationToolbar
                annotation={selectedAnnotation}
                anchor={annotationTarget.anchor}
                pane={readingPane}
                deleting={deleting.has(selectedAnnotation.id)}
                onDelete={(id) => void removeAnnotation(id)}
                onNote={editAnnotationNote}
                onQuote={quoteAnnotation}
                onAnswer={(annotation) => void answerQuestion(annotation)}
                onColor={(annotation, color) => void recolor(annotation, color)}
              />
            )}

            {activeSelection?.anchor && !noteOpen && (
              <SelectionToolbar
                anchor={activeSelection.anchor}
                pane={readingPane}
                onClose={closeSelectionUI}
                content={
                  translationRequest && (
                    <SelectionTranslation
                      inline
                      selection={translationRequest.selection}
                      delayMs={translationRequest.automatic ? 350 : 0}
                      onClose={closeSelectionUI}
                    />
                  )
                }
              >
                <ColorSwatchPicker color={markColor} onPick={chooseColor} />
                <IconButton
                  label="高亮"
                  onClick={() => void annotate("highlight", "", markColor)}
                >
                  <Highlighter />
                </IconButton>
                <span className="selection-bar-divider" />
                <IconButton
                  label="添加批注"
                  onClick={() => {
                    setNoteKind("note");
                    setEditingAnnotation(null);
                    setNoteSelection(activeSelection);
                    setNote("");
                    setNoteOpen(true);
                    setTranslationRequest(null);
                    adapter?.clearSelection();
                  }}
                >
                  <StickyNote />
                </IconButton>
                <IconButton label="引用到 AI 对话" onClick={addQuote}>
                  <Quote />
                </IconButton>
                <IconButton
                  label="划词翻译"
                  onClick={() => {
                    setTranslationRequest(
                      (current) =>
                        current ?? {
                          selection: activeSelection,
                          automatic: false,
                        },
                    );
                  }}
                >
                  <Languages />
                </IconButton>
                <span className="selection-bar-divider" />
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="更多文字操作"
                        title="更多文字操作"
                      />
                    }
                  >
                    <Ellipsis />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    data-selection-preserve=""
                    align="end"
                    className="w-40"
                    onMouseDown={(event) => event.preventDefault()}
                  >
                    <DropdownMenuCheckboxItem
                      checked={theme.autoTranslateSelection === true}
                      onCheckedChange={(checked) =>
                        setTheme({ autoTranslateSelection: checked === true })
                      }
                    >
                      <Languages />
                      自动划词翻译
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => void annotate("underline")}
                    >
                      <Underline />
                      下划线
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setNoteKind("question");
                        setEditingAnnotation(null);
                        setNoteSelection(activeSelection);
                        setNote("");
                        setNoteOpen(true);
                        setTranslationRequest(null);
                        adapter?.clearSelection();
                      }}
                    >
                      <CircleHelp />
                      提问
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SelectionToolbar>
            )}
          </div>
        </ResizablePanel>
        <ResizableHandle
          disabled={!right}
          className={`reader-assistant-resizer${right ? "" : " sidebar-handle-closed"}`}
        />
        <ResizablePanel
          id="assistant"
          panelRef={rightPanel}
          collapsible
          collapsedSize={0}
          style={{ overflow: "hidden" }}
          defaultSize="27%"
          minSize="280px"
          maxSize="45%"
        >
          <aside className="assistant-sidebar" data-open={right} inert={!right}>
            <Tabs
              value={rightTab}
              onValueChange={(value) => {
                cancelAnswerNavigation();
                setRightTab(String(value));
              }}
              className="h-full gap-0"
            >
              <div className="panel-header">
                <SlidingTabsList className="panel-tabs" aria-label="阅读侧栏">
                  <TabsTrigger value="ai">
                    <ChatCircleDots className="size-3.5" />
                    对话
                  </TabsTrigger>
                  <TabsTrigger value="notes">
                    <StickyNote className="size-3.5" />
                    批注<small>{annotations.length || ""}</small>
                  </TabsTrigger>
                </SlidingTabsList>
                <div className="panel-header-actions">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="聊天用量统计"
                    aria-label="聊天用量统计"
                    onClick={() => setUsageOpen(true)}
                  >
                    <ChartColumn className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="文档概要"
                    aria-label="文档概要"
                    onClick={() => setOverviewOpen(true)}
                  >
                    <BookOpen className="size-3.5" />
                  </Button>
                </div>
              </div>
              <TabsContent
                value="ai"
                className="ai-panel"
                style={
                  { "--assistant-font-scale": assistantSize } as CSSProperties
                }
              >
                <SessionPicker
                  documentId={doc.id}
                  sessions={sessions}
                  current={currentSession}
                  provider={provider}
                  running={sending}
                  onChange={(id) => {
                    cancelAnswerNavigation();
                    selectSession(id);
                  }}
                  onRefresh={async () => { await refreshSessions(); }}
                  onDeleted={sessionDeleted}
                />
                {sessionError && (
                  <div
                    className="px-3 py-2 text-sm text-destructive"
                    role="alert"
                  >
                    {sessionError}
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() =>
                        void refreshSessions().catch((error) =>
                          toast.error(error.message),
                        )
                      }
                    >
                      重试
                    </Button>
                  </div>
                )}
                <AssistantPanel
                  key={currentSession?.id ?? doc.id}
                  session={session}
                  focusAnswerId={focusAnswerId}
                  onAnswerFocused={clearAnswerTarget}
                  onRegenerate={() => void regenerate()}
                  regenerateDisabled={aiModelSaving || sending}
                  renderAnswer={(message, content) => (
                    <SourceReferences
                      key={message.id}
                      message={message}
                      toc={toc}
                      adapter={adapter}
                      onNavigate={visitReference}
                    >
                      {content}
                    </SourceReferences>
                  )}
                  empty={
                    <div className="chat-empty">
                      <div className="chat-empty-hero">
                        <span className="chat-empty-icon">
                          <Sparkles size={18} aria-hidden="true" />
                        </span>
                        <span className="chat-empty-title">开始对话</span>
                      </div>
                      <p className="chat-empty-hint">
                        选中文字提问，或直接问这一
                        {doc.type === "epub" ? "章" : "页"}。
                      </p>
                      <div className="chat-empty-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="suggestion"
                          disabled={!adapter}
                          onClick={() =>
                            void send(
                              doc.type === "epub"
                                ? "请总结当前章节的核心内容，并列出值得思考的问题。"
                                : "请总结当前 PDF 页的主要内容，保留重要术语。",
                              [],
                              true,
                            )
                          }
                        >
                          <span className="suggestion-icon">
                            <BookOpen aria-hidden="true" />
                          </span>
                          <span className="suggestion-copy">
                            <span className="suggestion-title">
                              总结当前{doc.type === "epub" ? "章节" : "页面"}
                            </span>
                            <span className="suggestion-hint">
                              要点、结构与值得追问的问题
                            </span>
                          </span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="suggestion"
                          disabled={!adapter}
                          onClick={() =>
                            void send(
                              "请找出当前内容的核心概念，并用简明的语言解释。",
                              [],
                              true,
                            )
                          }
                        >
                          <span className="suggestion-icon">
                            <Lightbulb aria-hidden="true" />
                          </span>
                          <span className="suggestion-copy">
                            <span className="suggestion-title">解释概念</span>
                            <span className="suggestion-hint">
                              用简明语言拆解核心概念
                            </span>
                          </span>
                        </Button>
                      </div>
                      <p className="privacy-note">
                        主动引用的文字和图片随问题发送；文档 Agent
                        按需检索、读取原文。
                      </p>
                    </div>
                  }
                  extras={(message) => (
                    <>
                      {!!message.attachments?.length &&
                        imageAttachments(message.attachments)}
                    </>
                  )}
                  references={(message) => (
                    <>
                      {message.readingLocation && (
                        <span
                          className="chat-reading-location"
                          title="提问时的阅读位置"
                        >
                          <BookOpen size={12} aria-hidden="true" />
                          {referenceLabel(message.readingLocation, toc)}
                        </span>
                      )}
                      <SourceReferences
                        message={message}
                        toc={toc}
                        adapter={adapter}
                        onNavigate={visitReference}
                      />
                    </>
                  )}
                />
                <div className="chat-compose">
                  {quotes.length > 0 && (
                    <div className="quote-chips">
                      {quotes.map((q, i) => {
                        const label = referenceLabel(q.location, toc);
                        return (
                          <div key={i}>
                            <Quote size={12} aria-hidden="true" />
                            <span title={q.text}>{q.text}</span>
                            <Button
                              size="xs"
                              variant="ghost"
                              className="quote-chip-location"
                              aria-label={`定位引用 · ${label}`}
                              title={label}
                              disabled={!adapter || referenceBusy}
                              onClick={() =>
                                void visitReference(q.location, q.text).catch(
                                  (error: Error) => toast.error(error.message),
                                )
                              }
                            >
                              <span>{label}</span>
                            </Button>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="移除引用"
                              onClick={() =>
                                setQuotes((items) =>
                                  items.filter((_, j) => j !== i),
                                )
                              }
                            >
                              <X />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {quotes.length === maxDraftQuotes && (
                    <p className="chat-status" role="status">
                      已添加 {maxDraftQuotes} 条引用。移除一条后可继续添加。
                    </p>
                  )}
                  {!!images.length && imageAttachments(images, true)}
                  <Textarea
                    ref={composeInput}
                    rows={2}
                    aria-label="向 AI 提问"
                    placeholder="问一个问题，或引用选中的文字…"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.altKey &&
                        !e.nativeEvent.isComposing &&
                        e.nativeEvent.keyCode !== 229
                      ) {
                        e.preventDefault();
                        if (!e.repeat && adapter && !sending) void send();
                      }
                    }}
                  />
                  <div className="compose-footer">
                    {provider ? (
                      <ModelSelector
                        disabled={sending || !currentSession}
                        onSettings={() => openChatSettings("models")}
                        modelsOnly
                      />
                    ) : (
                      <Button
                        className="model-select-trigger"
                        variant="ghost"
                        size="sm"
                        onClick={() => openChatSettings("connection")}
                      >
                        配置 AI 连接
                      </Button>
                    )}
                    {sending ? (
                      <Button
                        size="icon-sm"
                        variant="outline"
                        className="chat-stop"
                        title="停止回答"
                        aria-label="停止回答"
                        onClick={() => {
                          abort.current?.abort();
                          session.cancel();
                        }}
                      >
                        <Square size={11} weight="fill" />
                      </Button>
                    ) : (
                      <Button
                        size="icon-sm"
                        className="chat-send"
                        title="发送问题"
                        aria-label="发送问题"
                        disabled={
                          !adapter ||
                          aiModelSaving ||
                          !provider ||
                          !prompt.trim()
                        }
                        onClick={() => void send()}
                      >
                        <PaperPlaneTilt size={15} />
                      </Button>
                    )}
                  </div>
                </div>
              </TabsContent>
              <TabsContent value="notes" className="notes-panel">
                {answerStatus && (
                  <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
                    {answerStatus}
                  </p>
                )}
                <NotesPanel
                  document={doc}
                  annotations={annotations}
                  messages={chat.messages}
                  deleting={deleting}
                  answering={answering}
                  onGo={focusAnnotation}
                  onDelete={(id) => void removeAnnotation(id)}
                  onSave={saveAnnotationText}
                  onAnswer={(a) => void answerQuestion(a)}
                  onResolve={(a, resolved) => void resolveQuestion(a, resolved)}
                  onShowAnswer={(messageId) => void showAnswer(messageId)}
                  onExport={() => setExportingNotes(true)}
                  onRecover={async () => {
                    try {
                      const result = await api.recoverAnnotations(doc.id, true);
                      if (!result.checked) {
                        toast.error("请等待文档解析和翻译完成后再定位批注");
                        return;
                      }
                      const items = await api.annotations(doc.id);
                      if (recoveryDocument.current === doc.id)
                        setAnnotations(items);
                    } catch (e) {
                      toast.error((e as Error).message);
                    }
                  }}
                />
              </TabsContent>
            </Tabs>
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>

      <AnnotationHoverCard
        target={!activeSelection && !noteOpen ? hoveredAnnotation : null}
        annotations={annotations}
        onEdit={editAnnotationNote}
      />
      <LinkPreviewPanel
        key={`link-preview-${doc.id}`}
        preview={linkPreview}
        onDismiss={() => setLinkPreview(null)}
        onNavigate={(location) =>
          void visitReference(location, "").catch((error) =>
            toast.error(String(error)),
          )
        }
        renderKey={`${theme.mode}:${theme.pdfDarkImageMode}:${theme.pdfDarkContrast}`}
      />
      {previewImage && (
        <ImagePreview
          key={previewImage.id}
          documentId={doc.id}
          image={previewImage}
          renderImage={renderBlockImage}
          onClose={() => setPreviewImage(undefined)}
        />
      )}
      <Dialog
        open={noteOpen}
        onOpenChange={(open) => {
          if (noteSaving) return;
          setNoteOpen(open);
          if (!open) {
            setNoteSelection(null);
            setEditingAnnotation(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {noteKind === "question"
                ? editingAnnotation
                  ? "编辑问题"
                  : "提问"
                : editingAnnotation?.note.trim()
                  ? "编辑批注"
                  : "添加批注"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {noteKind === "question"
                ? "就当前选区提问"
                : "为当前选区添加批注"}
            </DialogDescription>
          </DialogHeader>
          <blockquote className="note-preview">
            {noteSelection && (
              <AnnotationQuote
                quote={noteSelection.text}
                location={noteSelection.location}
              />
            )}
          </blockquote>
          <Textarea
            autoFocus
            placeholder={
              noteKind === "question" ? "想弄清楚什么？" : "批注内容…"
            }
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {noteKind === "question" ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => void annotate("question", note)}
                disabled={noteSaving || !note.trim()}
              >
                <Check />
                保存问题
              </Button>
              {!editingAnnotation && (
                <Button
                  className="flex-1"
                  disabled={noteSaving || !note.trim() || !provider}
                  onClick={() =>
                    void annotate("question", note).then((saved) => {
                      if (saved) void answerQuestion(saved);
                    })
                  }
                >
                  <Sparkles />
                  保存并让 AI 回答
                </Button>
              )}
            </div>
          ) : (
            <Button
              onClick={() => void annotate("note", note)}
              disabled={
                noteSaving || (!note.trim() && !editingAnnotation?.note.trim())
              }
            >
              <Check />
              保存批注
            </Button>
          )}
        </DialogContent>
      </Dialog>
      {exportingNotes && (
        <ExportDocumentDialog
          key={`export-${doc.id}`}
          document={doc}
          annotations={annotations}
          messages={chat.messages}
          link={(a) => interleafLink({ id: doc.id, annotation: a.id })}
          onClose={() => setExportingNotes(false)}
        />
      )}
      <DocumentOverviewDialog
        key={`overview-${doc.id}`}
        document={overviewOpen ? doc : null}
        onClose={() => setOverviewOpen(false)}
        onNavigate={async (location) => {
          await adapter?.goTo(location);
        }}
      />
      <ProcessingUsageDialog
        document={usageOpen ? doc : null}
        onClose={() => setUsageOpen(false)}
      />
    </div>
  );
}
