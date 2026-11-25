import { useShortcut, loadBindings, isMac } from "./shortcuts/shortcuts";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BookOpen,
  UploadSimple,
  Books as Library,
  Star,
  MagnifyingGlass as Search,
  GearSix as Settings2,
  ArrowUpRight,
  ArrowClockwise,
  FileText,
  CircleNotch as LoaderCircle,
  SidebarSimple as PanelLeft,
  Command,
  Tag as Tags,
  PencilSimple as Pencil,
  Check,
  Info,
  Trash,
  Moon,
  DotsThree as Ellipsis,
  Sun,
} from "@phosphor-icons/react";
import { version } from "../../desktop/package.json";
import { api, researchAPI } from "@interleaf/api";
import { LargePaperConfirmation, LargePaperDialog } from "./LargePaperDialog";
import type { Document, LibraryMode } from "@interleaf/core";
import { Button } from "@interleaf/ui/components/button";
import { Tabs, TabsTrigger } from "@interleaf/ui/components/tabs";
import { SlidingTabsList } from "./controls/SlidingTabsList";
import { Input } from "@interleaf/ui/components/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@interleaf/ui/components/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@interleaf/ui/components/dialog";
import { Toaster, toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@interleaf/ui/components/dropdown-menu";
import {
  useReaderStore,
  refreshLibrary,
  libraryMode,
  loadLibraryPreferences,
  updateLibraryPreferences,
  refreshTrash,
  openLinkTarget,
} from "./store";
import { TrashView } from "./TrashView";
import { PaperLibrary } from "./papers/PaperLibrary";
import { PaperSidebar } from "./papers/PaperSidebar";
import { ResearchNavigation } from "./research/ResearchNavigation";
import { researchEpoch, researchSignal } from "./research/research-session";
import { usePaperUI } from "./papers/state";
import { ImportPaperDialog } from "./papers/ImportPaperDialog";
import { libraryModes } from "./LibraryModeSwitcher";
import type { SettingsTarget } from "./Settings";
import { useProcessing } from "./ProcessingStatus";
import { useUpdateProgress } from "./update-progress";
import { UpdateOfferHost } from "./UpdateOfferHost";
import { useResolvedTheme } from "./appearance";
import { DocumentEditor, LibraryFilterBar } from "./DocumentManagement";
import { TagBoards } from "./TagBoards";
import { LibraryDocuments } from "./LibraryDocuments";
import { filterDocuments, initialFilters } from "./library";
import { ReleaseNotesHost } from "./release-notes/ReleaseNotesHost";
import { libraryPapers } from "./papers/projection";
import { LibrarySearchDialog } from "./LibrarySearchDialog";
import { ImportResultsDialog } from "./ImportResultsDialog";
import { useLibraryImport, type ImportTarget } from "./library-import";
import { recordLibraryReady } from "./diagnostics";
import { observeOriginalTranslationReady } from "./translation/useBabelDOCReading";

const Workspace = lazy(() =>
  import("./Workspace").then(({ Workspace }) => ({ default: Workspace })),
);
const ResearchPanel = lazy(() =>
  import("./research/ResearchPanel").then(({ ResearchPanel }) => ({
    default: ResearchPanel,
  })),
);
const Settings = lazy(() =>
  import("./Settings").then(({ Settings }) => ({ default: Settings })),
);

const currentMode = () =>
  libraryMode(useReaderStore.getState().libraryPreferences);
export function App() {
  const {
    documents: allDocuments,
    paperItems,
    active,
    theme,
    setTheme,
    open,
    libraryPreferences,
    trash,
  } = useReaderStore();
  const mode = libraryMode(libraryPreferences);
  const [originalRequest, setOriginalRequest] = useState<{
    documentId: string;
    sequence: number;
  }>();
  useEffect(
    () =>
      observeOriginalTranslationReady((documentId) => {
        const id = `babeldoc:${documentId}`;
        const { documents } = useReaderStore.getState();
        if (!documents.some((document) => document.id === documentId)) return;
        toast.success("原版译文已就绪", {
          id,
          duration: 8000,
          closeButton: true,
          action: {
            label: "查看译文",
            onClick: () => {
              const reader = useReaderStore.getState();
              const document = reader.documents.find(
                (item) => item.id === documentId,
              );
              if (!document || document.metadataOnly) return;
              setOriginalRequest((current) => ({
                documentId,
                sequence: (current?.sequence ?? 0) + 1,
              }));
              if (reader.active?.id !== documentId) reader.open(document);
            },
          },
        });
      }),
    [],
  );
  const clearOriginalRequest = useCallback((sequence: number) => {
    setOriginalRequest((request) =>
      request?.sequence === sequence ? undefined : request,
    );
  }, []);
  const papers = mode === "papers";
  const researchTopicId = usePaperUI((s) => s.researchTopicId);
  const researchOpening = useRef<number | null>(null);
  const researchSelection = useRef(0);
  const openResearch = async (folder: string) => {
    if (researchOpening.current) return;
    const epoch = researchEpoch();
    const selection = ++researchSelection.current;
    const signal = researchSignal();
    researchOpening.current = selection;
    try {
      const topics = await researchAPI.listTopics(signal);
      const topic =
        topics.find(
          (topic) => topic.folder === folder && topic.scopeState === "active",
        ) ??
        (await researchAPI.createTopic(
          {
            title: folder.split("/").pop() || "全部论文",
            folder,
            includeChildren:
              useReaderStore.getState().libraryPreferences.papers
                ?.subcategoryItems !== false,
            networkAllowed: false,
          },
          signal,
        ));
      if (
        !signal.aborted &&
        researchEpoch() === epoch &&
        selection === researchSelection.current
      )
        usePaperUI.getState().setResearchTopic(topic.id);
    } catch (error) {
      if (!signal.aborted) toast.error((error as Error).message);
    } finally {
      if (selection === researchOpening.current) researchOpening.current = null;
    }
  };
  useEffect(
    () =>
      usePaperUI.subscribe((state, previous) => {
        if (
          state.view !== previous.view ||
          state.researchTopicId !== previous.researchTopicId
        )
          ++researchSelection.current;
      }),
    [],
  );
  const paperDocuments = useMemo(
    () => libraryPapers(paperItems, allDocuments),
    [paperItems, allDocuments],
  );
  const bookDocuments = useMemo(
    () => allDocuments.filter((d) => d.library === "books"),
    [allDocuments],
  );
  const documents = papers ? paperDocuments : bookDocuments;
  const resolvedTheme = useResolvedTheme(theme);
  const { jobs, error: processingError } = useProcessing();
  useUpdateProgress();
  const jobsById = useMemo(
    () => new Map(jobs.map((job) => [job.documentId, job])),
    [jobs],
  );
  const [settings, setSettings] = useState<{
    open: boolean;
    target?: SettingsTarget;
  }>();
  const openSettings = (target?: SettingsTarget) => {
    setSettings({ open: true, target });
  };
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [about, setAbout] = useState(false);
  const closeAbout = useCallback(() => setAbout(false), []);
  const [filter, setFilter] = useState("all");
  const [filters, setFilters] = useState(initialFilters);
  const [libraryView, setLibraryView] = useState<"grid" | "list">("grid");
  const [editingLibrary, setEditingLibrary] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const importer = useLibraryImport();
  const [sampleBusy, setSampleBusy] = useState(false);
  const busy = sampleBusy || importer.busy;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [command, setCommand] = useState(false);
  const [importingPaper, setImportingPaper] = useState(false);
  const [nav, setNav] = useState(true);
  useShortcut("libraryLeft", () => setNav((value) => !value), !active);
  useShortcut("search", () => setCommand(true), !active);
  const fileRef = useRef<HTMLInputElement>(null);
  const fileTargetRef = useRef<ImportTarget | null>(null);
  const chooseFilesRef = useRef<() => void>(() => {});
  const hydrated = useRef(false);
  useEffect(() => {
    Promise.all([
      refreshLibrary(),
      loadLibraryPreferences(),
      api.settings().then((value) => setTheme(value)),
    ])
      .catch((e) => setError(e.message))
      .finally(() => {
        setLoading(false);
        hydrated.current = true;
      });
  }, [setTheme]);
  useEffect(() => {
    void loadBindings().catch(() =>
      toast.error("快捷键设置读取失败，暂时使用默认快捷键。"),
    );
  }, []);
  useEffect(() => {
    if (loading || error || active || (papers && researchTopicId)) return;
    const ready = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", ready);
      recordLibraryReady();
    };
    document.addEventListener("visibilitychange", ready);
    ready();
    return () => document.removeEventListener("visibilitychange", ready);
  }, [loading, error, active, papers, researchTopicId]);
  useEffect(() => {
    if (loading) return;
    void refreshTrash().catch((e) => toast.error(e.message));
  }, [mode, loading]);
  useEffect(() => {
    if (!hydrated.current) return;
    const timer = setTimeout(() => {
      void api.saveSettings(theme).catch((e) => toast.error(e.message));
    }, 350);
    return () => clearTimeout(timer);
  }, [theme]);
  useEffect(() => {
    const dark = resolvedTheme.mode === "dark";
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.theme = resolvedTheme.mode;
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    void window.interleafDesktop
      ?.setAppearance(theme.appearance ?? "system")
      .catch((e) => toast.error(e.message));
  }, [resolvedTheme.mode, theme.appearance]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommand((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "o") {
        e.preventDefault();
        chooseFilesRef.current();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const currentPaperFolder = () => {
    const view = usePaperUI.getState().view;
    return currentMode() === "papers" &&
      (view.startsWith("folder:") || view.startsWith("smart:"))
      ? view
      : "";
  };
  const importTarget = (folder = currentPaperFolder()): ImportTarget => {
    const library = currentMode();
    return { library, folder: library === "papers" ? folder : "" };
  };
  const chooseFiles = (folder?: string) => {
    if (busy || importer.entries.length) return;
    const target = importTarget(folder);
    if (window.interleafDesktop) {
      void importer.choose(target);
    } else {
      fileTargetRef.current = target;
      fileRef.current?.click();
    }
  };
  chooseFilesRef.current = chooseFiles;
  useEffect(() => {
    if (loading) return;
    return window.interleafDesktop?.onOpenLink?.((target) => {
      void openLinkTarget(target)
        .then((found) => {
          if (!found) toast.error("找不到这份文档，它可能已被删除或在回收站中");
        })
        .catch((e) => toast.error((e as Error).message));
    });
  }, [loading]);
  useEffect(
    () =>
      window.interleafDesktop?.onLibraryChanged(() => {
        void refreshLibrary().catch((e) => toast.error(e.message));
      }),
    [],
  );
  useEffect(() => {
    let active = true;
    let revision = 0;
    const check = async () => {
      try {
        const latest = (await api.connectorRevision()).revision;
        if (!active) return;
        if (latest !== revision) await refreshLibrary();
        revision = latest;
      } catch {
        /* Reader shutdown is handled by the desktop shell. */
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const sample = async () => {
    setSampleBusy(true);
    try {
      for (const name of ["the-art-of-reading.epub", "reading-notes.pdf"]) {
        const response = await fetch(`/samples/${name}`);
        if (!response.ok) throw new Error("示例文件不可用");
        await api.import(new File([await response.blob()], name));
      }
      await refreshLibrary();
      toast.success("已添加两份示例，可随时开始阅读");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSampleBusy(false);
    }
  };
  const cancelResearchOpening = () => {
    ++researchSelection.current;
    researchOpening.current = null;
  };
  const switchMode = (next: LibraryMode) => {
    if (next === mode) return;
    cancelResearchOpening();
    usePaperUI.getState().setResearchTopic(null);
    setFilter("all");
    setFilters(initialFilters);
    setQuery("");
    setEditingLibrary(false);
    void updateLibraryPreferences({ mode: next }).catch((e) =>
      toast.error(e.message),
    );
  };
  const moveDocument = async (doc: Document, library: LibraryMode) => {
    try {
      await api.update(doc.id, { library });
      await refreshLibrary();
      toast.success(`已移到${libraryModes[library].label}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const openDocument = (doc: Document) => {
    if (doc.metadataOnly) return;
    doc = allDocuments.find((d) => d.id === doc.id) || doc;
    setEditingLibrary(false);
    open(doc);
    void api.update(doc.id, {}).catch((e) => toast.error(e.message));
  };
  const openSearchResult = (doc: Document) => {
    switchMode(doc.library);
    if (!doc.metadataOnly) {
      openDocument(doc);
      return;
    }
    cancelResearchOpening();
    open(null);
    const paperUI = usePaperUI.getState();
    paperUI.setView("all");
    paperUI.setQuery("");
    paperUI.setTagFilter({ ...paperUI.tagFilter, tags: [] });
    paperUI.stopPicking();
    paperUI.select(doc.id);
  };
  const filtered = filterDocuments(
    documents,
    filter,
    filter === "all" ? "" : query,
    filters,
  );
  const editing = documents.find((d) => d.id === editingId);
  const awaitingClassification = documents.some(
    (d) =>
      d.classificationStatus === "pending" ||
      d.classificationStatus === "running",
  );
  useEffect(() => {
    if (!awaitingClassification) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refreshLibrary();
      } catch {
        /* Keep the last available library during a transient disconnect. */
      }
      if (!stopped) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 2500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [awaitingClassification]);
  const favorite = async (doc: Document) => {
    try {
      await api.update(doc.id, { favorite: !doc.favorite });
      await refreshLibrary();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <TooltipProvider delay={350} timeout={500}>
      <div
        className="app"
        data-platform={window.interleafDesktop?.platform}
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (!busy)
            void importer.drop(
              Array.from(e.dataTransfer.files),
              importTarget(),
            );
        }}
      >
        <input
          type="file"
          ref={fileRef}
          hidden
          multiple
          accept={papers ? ".pdf" : ".pdf,.epub"}
          onChange={(e) => {
            void importer.drop(
              Array.from(e.target.files || []),
              fileTargetRef.current ?? importTarget(),
            );
            fileTargetRef.current = null;
            e.target.value = "";
          }}
        />
        {active ? (
          <Suspense
            fallback={
              <main className="empty-state">
                <p role="status">正在打开文档…</p>
                <Button variant="outline" onClick={() => open(null)}>
                  {papers && researchTopicId ? "返回主题研究" : "返回书库"}
                </Button>
              </main>
            }
          >
            <Workspace
              key={active.id}
              document={active}
              theme={resolvedTheme}
              processing={jobs.find((job) => job.documentId === active.id)}
              originalTranslationRequest={
                originalRequest?.documentId === active.id
                  ? originalRequest.sequence
                  : undefined
              }
              onOriginalTranslationOpened={clearOriginalRequest}
              onBack={() => {
                open(null);
                void refreshLibrary();
              }}
              onSettings={openSettings}
              backLabel={papers && researchTopicId ? "返回主题研究" : undefined}
            />
          </Suspense>
        ) : (
          <>
            <header className="global-nav">
              <div className="gnav-left">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="gnav-icon"
                        aria-label="切换侧栏"
                        aria-expanded={nav}
                        onClick={() => setNav(!nav)}
                      />
                    }
                  >
                    <PanelLeft />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {nav ? "收起书库侧栏" : "展开书库侧栏"}
                  </TooltipContent>
                </Tooltip>
                <Tabs
                  className="gnav-modes"
                  value={mode}
                  onValueChange={(value) => switchMode(value as LibraryMode)}
                >
                  <SlidingTabsList aria-label="切换书库">
                    {(["papers", "books"] as const).map((item) => (
                      <TabsTrigger
                        key={item}
                        value={item}
                        className="gnav-mode"
                      >
                        {libraryModes[item].label}
                      </TabsTrigger>
                    ))}
                  </SlidingTabsList>
                </Tabs>
              </div>
              <button
                type="button"
                className="gnav-search"
                aria-label="快速查找"
                aria-keyshortcuts={isMac() ? "Meta+K" : "Control+K"}
                onClick={() => setCommand(true)}
              >
                <Search />
                <span className="gnav-search-label">搜索标题、作者、DOI</span>
                <span className="gnav-shortcut" aria-hidden="true">
                  <kbd>
                    {isMac() ? (
                      <Command weight="regular" className="size-3" />
                    ) : (
                      "Ctrl"
                    )}
                  </kbd>
                  <kbd>K</kbd>
                </span>
              </button>
              <div className="gnav-right">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="gnav-icon"
                        aria-label="界面主题"
                        title="界面主题"
                      />
                    }
                  >
                    {resolvedTheme.mode === "dark" ? (
                      <Moon />
                    ) : resolvedTheme.mode === "sepia" ? (
                      <BookOpen />
                    ) : (
                      <Sun />
                    )}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuRadioGroup
                      value={theme.appearance ?? "system"}
                      onValueChange={(value) =>
                        setTheme({
                          appearance: value,
                          mode:
                            value === "dark" || value === "sepia"
                              ? value
                              : "light",
                        })
                      }
                    >
                      {(
                        [
                          ["system", "跟随系统"],
                          ["light", "浅色"],
                          ["dark", "深色"],
                          ["sepia", "纸张"],
                        ] as const
                      ).map(([value, label]) => (
                        <DropdownMenuRadioItem
                          key={value}
                          value={value}
                          closeOnClick
                        >
                          {label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="gnav-icon"
                        aria-label="设置"
                        onClick={() => openSettings()}
                      />
                    }
                  >
                    <Settings2 />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">设置</TooltipContent>
                </Tooltip>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="gnav-icon"
                        aria-label="更多"
                        title="更多操作"
                      />
                    }
                  >
                    <Ellipsis weight="bold" className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onClick={() => setAbout(true)}>
                      <Info />
                      关于纸间
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <div className="px-1.5 py-1 text-xs text-ink-faint">
                      版本 {version}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  size="sm"
                  className="gnav-import"
                  onClick={
                    papers ? () => setImportingPaper(true) : () => chooseFiles()
                  }
                  disabled={busy}
                >
                  {busy ? (
                    <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <UploadSimple className="size-4" />
                  )}
                  {busy ? "导入中…" : "导入"}
                </Button>
              </div>
            </header>
            <div className="app-body">
              <aside
                className={`library-sidebar ${nav ? "" : "collapsed"}`}
                inert={!nav}
              >
                {papers ? (
                  <PaperSidebar
                    documents={documents}
                    jobs={jobsById}
                    trashCount={trash.length}
                    openDocument={openDocument}
                    onNewCategory={() => usePaperUI.getState().setNaming([])}
                    onResearchFolder={(folder) => void openResearch(folder)}
                  />
                ) : (
                  <nav className="rail-nav" aria-label="书库">
                    <h2 className="rail-heading">书库</h2>
                    {[
                      {
                        id: "all",
                        label: "全部文档",
                        icon: Library,
                        count: documents.length,
                      },
                      {
                        id: "tags",
                        label: "标签看板",
                        icon: Tags,
                        count: undefined,
                      },
                      {
                        id: "favorites",
                        label: "收藏",
                        icon: Star,
                        count: documents.filter((d) => d.favorite).length,
                      },
                      ...(trash.length || filter === "trash"
                        ? [
                            {
                              id: "trash",
                              label: "回收站",
                              icon: Trash,
                              count: trash.length,
                            },
                          ]
                        : []),
                    ].map((item) => (
                      <Button
                        key={item.id}
                        variant="ghost"
                        className={`nav-item ${filter === item.id ? "active" : ""}`}
                        onClick={() => {
                          setFilter(item.id);
                          setEditingLibrary(false);
                        }}
                      >
                        <item.icon className="size-4" />
                        <span>{item.label}</span>
                        <span className="nav-count">{item.count}</span>
                      </Button>
                    ))}
                  </nav>
                )}
                {papers && <ResearchNavigation />}
              </aside>
              {papers && researchTopicId ? (
                <Suspense
                  fallback={
                    <main className="library-main">
                      <div className="empty-state">
                        <p role="status">正在打开主题研究…</p>
                      </div>
                    </main>
                  }
                >
                  <ResearchPanel
                    topicId={researchTopicId}
                    onSettings={openSettings}
                    onOpenDocument={async (documentId, location) => {
                      const document = useReaderStore
                        .getState()
                        .documents.find(
                          (document) => document.id === documentId,
                        );
                      if (
                        !document ||
                        document.metadataOnly ||
                        document.type !== location.type
                      )
                        throw new Error("原文不可用，请返回论文库检查附件。");
                      usePaperUI
                        .getState()
                        .setResearchTarget({ documentId, location });
                      useReaderStore.getState().open(document);
                    }}
                  />
                </Suspense>
              ) : error ? (
                <main className="library-main">
                  <div className="empty-state">
                    <h2>暂时无法连接本地书库</h2>
                    <p>{error}</p>
                    <Button variant="outline" onClick={() => location.reload()}>
                      重新连接
                    </Button>
                  </div>
                </main>
              ) : papers ? (
                <PaperLibrary
                  documents={documents}
                  trash={trash}
                  jobs={jobsById}
                  loading={loading}
                  openDocument={openDocument}
                  moveToBooks={(doc) => void moveDocument(doc, "books")}
                  onResearchFolder={(folder) => void openResearch(folder)}
                  onImportFiles={() => chooseFiles()}
                  onImportOther={() => setImportingPaper(true)}
                  importing={busy}
                />
              ) : (
                <main className="library-main">
                  <header className="library-topbar">
                    <div className="flex min-w-0 items-baseline gap-2.5">
                      <h1 className="library-title truncate">
                        {filter === "tags"
                          ? "标签看板"
                          : filter === "trash"
                            ? "回收站"
                            : filter === "favorites"
                              ? "收藏"
                              : "全部文档"}
                      </h1>
                      {filter !== "tags" && filter !== "trash" && (
                        <span className="text-xs tabular-nums text-ink-faint">
                          {filtered.length}
                        </span>
                      )}
                    </div>
                    {filter === "tags" ? (
                      <div className="search-field">
                        <Search className="size-4" />
                        <Input
                          aria-label="搜索书库"
                          placeholder="搜索标题、作者、标签…"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </div>
                    ) : filter === "trash" ? null : (
                      <Button
                        variant={editingLibrary ? "secondary" : "outline"}
                        aria-pressed={editingLibrary}
                        disabled={!filtered.length && !editingLibrary}
                        onClick={() => setEditingLibrary(!editingLibrary)}
                      >
                        {editingLibrary ? <Check /> : <Pencil />}
                        {editingLibrary ? "完成" : "编辑"}
                      </Button>
                    )}
                  </header>
                  <div className="library-content">
                    {filter === "favorites" && (
                      <div className="library-controls">
                        <div className="search-field">
                          <Search className="size-4" />
                          <Input
                            aria-label="搜索书库"
                            placeholder="搜索标题、作者、标签…"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                          />
                        </div>
                      </div>
                    )}
                    {filter !== "tags" && filter !== "trash" && (
                      <LibraryFilterBar
                        documents={documents}
                        filters={filters}
                        onChange={setFilters}
                        view={libraryView}
                        onViewChange={setLibraryView}
                        count={filtered.length}
                      />
                    )}
                    {processingError && (
                      <p className="processing-warning" role="status">
                        解析进度暂时不可用：{processingError}
                      </p>
                    )}
                    {loading ? (
                      <div className="empty-state">
                        <LoaderCircle className="animate-spin text-muted-foreground" />
                        <p>正在打开本地书库</p>
                      </div>
                    ) : filter === "trash" ? (
                      <TrashView documents={trash} />
                    ) : filter === "tags" ? (
                      <TagBoards
                        documents={documents}
                        query={query}
                        jobs={jobs}
                        processingError={processingError}
                        openDocument={openDocument}
                        favorite={favorite}
                        onEdit={setEditingId}
                        onSettings={() => openSettings()}
                      />
                    ) : filtered.length ? (
                      <LibraryDocuments
                        key={JSON.stringify([filter, query, filters])}
                        documents={filtered}
                        libraryView={libraryView}
                        editing={editingLibrary}
                        onEditingChange={setEditingLibrary}
                        jobs={jobs}
                        processingError={processingError}
                        openDocument={openDocument}
                        favorite={favorite}
                        onEdit={setEditingId}
                        onMove={moveDocument}
                        onSettings={() => openSettings()}
                      />
                    ) : (
                      <div className="empty-state">
                        <div className="empty-books">
                          <span>
                            <FileText />
                          </span>
                          <span>
                            <BookOpen />
                          </span>
                        </div>
                        <h2>
                          {documents.length
                            ? "没有符合筛选条件的文档"
                            : filter === "favorites"
                              ? "暂无收藏"
                              : "暂无文档"}
                        </h2>
                        {!!documents.length && (
                          <Button
                            variant="outline"
                            onClick={() => {
                              setFilters(initialFilters);
                              setQuery("");
                              setFilter("all");
                            }}
                          >
                            显示全部文档
                          </Button>
                        )}
                        {!documents.length && filter === "all" && (
                          <div className="flex flex-wrap items-center justify-center gap-2">
                            <Button
                              onClick={() => chooseFiles()}
                              disabled={busy}
                            >
                              <UploadSimple />
                              导入 EPUB / PDF
                            </Button>
                            <Button
                              variant="link"
                              onClick={() => void sample()}
                              disabled={busy}
                            >
                              先体验示例文档 <ArrowUpRight className="size-3" />
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </main>
              )}
            </div>
          </>
        )}
        {editing && (
          <DocumentEditor
            key={editing.id}
            document={editing}
            documents={documents}
            onClose={() => setEditingId(null)}
          />
        )}
        {settings && (
          <Suspense
            fallback={
              <div
                className="pointer-events-none fixed right-4 top-14 z-50 rounded-lg border bg-background px-3 py-2 text-sm text-foreground shadow-sm"
                role="status"
              >
                正在打开设置…
              </div>
            }
          >
            <Settings
              open={settings.open}
              onOpenChange={(open) => setSettings({ ...settings, open })}
              target={settings.target}
            />
          </Suspense>
        )}
        <ImportPaperDialog
          open={importingPaper}
          onOpenChange={setImportingPaper}
          onChooseFiles={(folder) => chooseFiles(folder)}
        />
        <ReleaseNotesHost
          ready={!loading && !error}
          version={version}
          hasDocuments={allDocuments.length > 0}
        />
        <Dialog open={about} onOpenChange={setAbout}>
          <DialogContent className="about-dialog">
            <DialogHeader className="about-dialog-header">
              <img
                src="/brand/logo.svg?v=green-1"
                alt=""
                aria-hidden="true"
                className="size-11 shrink-0 rounded-xl dark:hidden"
              />
              <img
                src="/brand/logo-dark.svg?v=green-1"
                alt=""
                aria-hidden="true"
                className="hidden size-11 shrink-0 rounded-xl dark:block"
              />
              <div className="about-dialog-heading">
                <DialogTitle>关于纸间 Interleaf</DialogTitle>
                <DialogDescription>本地 EPUB / PDF 阅读器</DialogDescription>
              </div>
            </DialogHeader>
            <div className="about-update-row">
              <dl className="about-version">
                <dt>当前版本</dt>
                <dd>{version}</dd>
              </dl>
              {window.interleafDesktop?.checkForUpdates && (
                <Button
                  className="about-update-action"
                  aria-busy={checkingUpdates}
                  disabled={checkingUpdates}
                  onClick={() => {
                    setCheckingUpdates(true);
                    void window
                      .interleafDesktop!.checkForUpdates()
                      .catch((error) => toast.error(String(error)))
                      .finally(() => setCheckingUpdates(false));
                  }}
                >
                  {checkingUpdates ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="motion-safe:animate-spin"
                    />
                  ) : (
                    <ArrowClockwise aria-hidden="true" />
                  )}
                  {checkingUpdates ? "正在检查或下载…" : "检查更新"}
                </Button>
              )}
            </div>
          </DialogContent>
        </Dialog>
        <UpdateOfferHost onOffer={closeAbout} />
        <LibrarySearchDialog
          open={command}
          onOpenChange={setCommand}
          mode={mode}
          books={bookDocuments}
          papers={paperDocuments}
          jobs={jobsById}
          onSelect={openSearchResult}
          onSettings={openSettings}
        />
        <ImportResultsDialog
          open={importer.entries.length > 0 && !importer.confirm.length}
          entries={importer.entries}
          busy={importer.busy}
          refreshError={importer.refreshError}
          onClose={importer.close}
          onRetry={() => void importer.retry()}
          onRead={(entry) => void importer.read(entry, openSearchResult)}
        />
        <LargePaperConfirmation />
        <LargePaperDialog
          papers={importer.confirm.map(({ result }) => ({
            name: result.name,
            pages: result.pages ?? 0,
          }))}
          busy={busy}
          onChoose={(library) => void importer.retry(library)}
          onCancel={importer.cancelLarge}
        />
        <Toaster
          richColors
          position="bottom-right"
          theme={resolvedTheme.mode === "dark" ? "dark" : "light"}
        />
      </div>
    </TooltipProvider>
  );
}
