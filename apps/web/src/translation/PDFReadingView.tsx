import { figureTarget } from "../engines/figure-references";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslations } from "./useTranslations";
import { createPortal } from "react-dom";
import { Crosshair } from "@phosphor-icons/react";
import type {
  Annotation,
  Document as ReaderDocument,
  DocumentLocation,
  PDFBlock,
  PDFReadingAnchor,
  Processing,
  ReaderAdapter,
  ReaderEvents,
  ReaderSelection,
  ReaderTheme,
  SearchResult,
  TOCItem,
  TranslationBlock,
} from "@interleaf/core";
import { defaultTheme, isPDFPageDecoration } from "@interleaf/core";
import { api } from "@interleaf/api";
import { Button } from "@interleaf/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@interleaf/ui/components/tooltip";
import { Popover, PopoverContent } from "@interleaf/ui/components/popover";
import { toast } from "sonner";
import { InterleafView } from "../InterleafView";
import {
  locationAtReadingAnchor,
  overlap,
  ReadingSync,
} from "../engines/pdf-reading";
import { animatePDFScroll } from "../engines/pdf-scroll";
import { TranslationPanes, useTranslationSplit } from "./TranslationPanes";
import { formulaNumbers } from "./formulaNumbers";
import { TranslationText } from "./TranslationText";
import { TranslationJobStatus } from "./TranslationJobStatus";
import { blockImageCache } from "./block-images";
import { useSentenceMarks } from "./useSentenceMarks";
import { translatedSelection as captureTranslationSelection } from "./selection";
import { installTranslationSelectionHighlight } from "./selection-highlight";
import { translationFont } from "../appearance";
import { selectSentence } from "../engines/sentence-selection";
import { installCitationHover } from "../engines/citation-hover";
import { numberedReference } from "../engines/pdf-citations";
import "./translation.css";

import { AssistanceControls } from "./AssistanceControls";
import { NativePDFReadingView } from "./NativePDFReadingView";
import { chapterRange, headingPages } from "./chapters";
import { searchPDFBlocks } from "./pdf-search";

import {
  PDFReadingControls,
  type PDFReadingContent,
  type PDFReadingFormat,
} from "./PDFReadingControls";

type Mode =
  "source" | "parallel" | "native" | "translation" | "native-translation";
const isNativeMode = (value: Mode): value is "native" | "native-translation" =>
  value === "native" || value === "native-translation";
function readingMode(
  content: PDFReadingContent,
  format: PDFReadingFormat,
): Mode {
  if (content === "source" || format === "flow") return content;
  return content === "parallel" ? "native" : "native-translation";
}
function needsOriginalPage(location: DocumentLocation) {
  return (
    location.type === "pdf" &&
    !location.translation &&
    Boolean(
      location.rects?.length ||
      location.sourceAnchors?.length ||
      location.sentenceLink?.origin === "source",
    )
  );
}
const emptySearchResults: SearchResult[] = [];
export function PDFReadingView({
  document: doc,
  theme,
  annotations,
  blocks,
  processing,
  toolbarHost,
  autoCenterHost,
  pageNavigation,
  sidebarsOpen,
  searchResults = emptySearchResults,
  searchQuery = "",
  onReady,
  onAdapterDetached,
  events,
}: {
  document: ReaderDocument;
  theme: ReaderTheme;
  annotations: Annotation[];
  blocks: PDFBlock[];
  processing?: Processing;
  toolbarHost?: HTMLElement | null;
  autoCenterHost?: HTMLElement | null;
  pageNavigation?: ReactNode;
  sidebarsOpen?: { left: boolean; right: boolean };
  searchResults?: SearchResult[];
  searchQuery?: string;
  onReady: (adapter: ReaderAdapter, toc: TOCItem[]) => void;
  onAdapterDetached?: () => void;
  events: ReaderEvents;
}) {
  const [content, setContent] = useState<PDFReadingContent>("source"),
    [format, setFormat] = useState<PDFReadingFormat>("native"),
    [syncEnabled, setSyncEnabled] = useState(true);
  const split = useTranslationSplit();
  const mode = readingMode(content, format);
  const { translations, error } = useTranslations(doc.id);
  const [popup, setPopup] = useState<{ block: PDFBlock; rect: DOMRect }>();
  const [engine, setEngine] = useState<ReaderAdapter>();
  const [engineDocument, setEngineDocument] = useState<string>();
  const hoveredBlock = useRef<string | undefined>(undefined);
  const focusedBlock = useRef<string | undefined>(undefined);
  const translationNodesById = useRef(new Map<string, HTMLElement>());
  // Interaction markers own only these attributes. Content remains React-owned.
  const setMarker = (
    marker: "hovered" | "focused",
    current: { current: string | undefined },
    id?: string,
  ) => {
    if (current.current === id) return;
    const previous =
      current.current && translationNodesById.current.get(current.current);
    if (previous) previous.removeAttribute(`data-${marker}`);
    if (marker === "focused" && previous)
      previous.removeAttribute("aria-current");
    current.current = id;
    const next = id && translationNodesById.current.get(id);
    if (next) next.setAttribute(`data-${marker}`, "true");
    if (marker === "focused" && next) next.setAttribute("aria-current", "true");
  };
  const setHoveredBlock = (id?: string) =>
    setMarker("hovered", hoveredBlock, id);
  const setFocusedBlock = (id?: string) =>
    setMarker("focused", focusedBlock, id);
  const hoverOwner = useRef<"source" | "translation" | undefined>(undefined);
  const hover = (origin: "source" | "translation", blockId?: string) => {
    if (!blockId && hoverOwner.current !== origin) return;
    hoverOwner.current = blockId ? origin : undefined;
    setHoveredBlock(blockId);
    engine?.hoverBlock?.(
      mode === "parallel" && origin === "translation"
        ? (blockId ?? null)
        : null,
    );
  };
  const previousMode = useRef<Mode>("source");
  const syncEnabledRef = useRef(syncEnabled);
  syncEnabledRef.current = syncEnabled;
  const enteringParallel = useRef<string | undefined>(undefined);
  const explicitFocus = useRef({
    operation: 0,
    moving: false,
  });
  const root = useRef<HTMLDivElement>(null),
    pane = useRef<HTMLDivElement>(null),
    control = useRef(new ReadingSync()),
    side = useRef<"source" | "translation">("source"),
    reading = useRef<PDFReadingAnchor | undefined>(undefined);
  const nativeLocation = useRef<{
    documentId: string;
    location?: DocumentLocation;
    restoreSource?: boolean;
  }>({ documentId: doc.id, location: doc.progress });
  const nativeAdapter = useRef<
    | {
        documentId: string;
        adapter: ReaderAdapter;
      }
    | undefined
  >(undefined);
  if (nativeLocation.current.documentId !== doc.id) {
    nativeLocation.current = { documentId: doc.id, location: doc.progress };
    nativeAdapter.current = undefined;
  }
  const translationNodes = useRef<HTMLElement[]>([]);
  const sourceActive = useRef(true);
  const recordReading = (anchor: PDFReadingAnchor) => {
    reading.current = anchor;
  };
  const translationMotion = useRef({
    operation: 0,
    moving: false,
    blockId: "",
  });
  const pressedBlock = useRef<{ id: string; x: number; y: number } | undefined>(
    undefined,
  );
  const cancelTranslationMotion = () => {
    translationMotion.current.operation++;
    translationMotion.current.moving = false;
  };
  useLayoutEffect(() => {
    const host = pane.current;
    if (!host) return;
    let initialized = false;
    const resize = () => {
      const node = Array.from(
        host.querySelectorAll<HTMLElement>("[data-translation-block]"),
      ).find(
        (node) => node.dataset.translationBlock === reading.current?.blockId,
      );
      const before = node?.getBoundingClientRect().top;
      host.style.setProperty(
        "--translation-inset",
        `${host.clientHeight / 2}px`,
      );
      if (initialized && node && before !== undefined)
        host.scrollTop += node.getBoundingClientRect().top - before;
      initialized = true;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => {
      observer.disconnect();
      cancelTranslationMotion();
    };
  }, [mode, doc.id]);
  const sourceBlocksById = useMemo(
    () => new Map(blocks.map((block) => [block.id, block])),
    [blocks],
  );
  const state = useRef({
    sourceBlocksById,
    mode,
    blocks,
    translations,
    events,
    theme,
    documentId: doc.id,
  });
  state.current = {
    sourceBlocksById,
    mode,
    blocks,
    translations,
    events,
    theme,
    documentId: doc.id,
  };
  useSentenceMarks(
    root,
    isNativeMode(mode) ? undefined : engine,
    blocks,
    translations,
    annotations,
    theme.linkTranslationAnnotations !== false,
    mode,
    events,
    searchQuery,
    searchResults,
  );
  const byId = useMemo(
    () => new Map(translations.map((t) => [t.blockId, t])),
    [translations],
  );
  const sourceAnnotations = useMemo(
    () =>
      annotations.filter(
        (annotation) =>
          annotation.location.type !== "pdf" ||
          !annotation.location.translation,
      ),
    [annotations],
  );
  const selecting = useRef(false),
    selection = useRef<ReaderSelection | null>(null),
    scrollFrame = useRef(0);
  const equationNumbers = useMemo(() => formulaNumbers(blocks), [blocks]);
  const [imageCache, setImageCache] = useState<{
    engine: ReaderAdapter;
    documentId: string;
    cache: ReturnType<typeof blockImageCache>;
  }>();
  const blockImages =
    imageCache?.engine === engine && imageCache?.documentId === doc.id
      ? imageCache.cache
      : undefined;
  useEffect(() => {
    if (!engine?.renderBlockImage || engineDocument !== doc.id) return;
    const cache = blockImageCache(engine.renderBlockImage.bind(engine));
    setImageCache({ engine, documentId: doc.id, cache });
    return () => {
      cache.dispose();
      setImageCache(undefined);
    };
  }, [engine, engineDocument, doc.id]);
  const visibleBlocks = useMemo(
    () =>
      blocks.filter(
        (b) => !isPDFPageDecoration(b) && !equationNumbers.pairedIds.has(b.id),
      ),
    [blocks, equationNumbers],
  );
  const lastPage = useMemo(
    () => Math.max(1, ...blocks.map((block) => block.page)),
    [blocks],
  );
  useLayoutEffect(() => {
    sourceActive.current = true;
    return () => {
      sourceActive.current = false;
      setHoveredBlock(undefined);
      setFocusedBlock(undefined);
      hoverOwner.current = undefined;
      explicitFocus.current.operation++;
      explicitFocus.current.moving = false;
      cancelTranslationMotion();
      cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = 0;
    };
  }, [mode, doc.id]);
  useLayoutEffect(() => {
    const nodes = Array.from(
      pane.current?.querySelectorAll<HTMLElement>("[data-translation-block]") ??
        [],
    );
    translationNodes.current = nodes;
    translationNodesById.current = new Map(
      nodes.map((node) => [node.dataset.translationBlock!, node]),
    );
    const hovered =
      hoveredBlock.current &&
      translationNodesById.current.get(hoveredBlock.current);
    if (hovered) hovered.setAttribute("data-hovered", "true");
    const focused =
      focusedBlock.current &&
      translationNodesById.current.get(focusedBlock.current);
    if (focused) {
      focused.setAttribute("data-focused", "true");
      focused.setAttribute("aria-current", "true");
    }
    return () => {
      translationNodes.current = [];
      translationNodesById.current.clear();
    };
  }, [mode, doc.id, visibleBlocks]);
  const searchBlockIds = useMemo(
    () => [
      ...new Set(
        searchResults
          .map((result) => result.blockId)
          .filter((id): id is string => !!id),
      ),
    ],
    [searchResults],
  );
  useEffect(() => {
    engine?.setSearchBlocks?.(searchBlockIds);
  }, [engine, searchBlockIds]);
  useEffect(() => {
    if (pane.current) return installTranslationSelectionHighlight(pane.current);
  }, [mode, doc.id]);
  const translate = async (blockId = "") => {
    try {
      await api.translate(doc.id, blockId);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const targetNode = (id: string) => translationNodesById.current.get(id);
  const followTranslation = (
    anchor: PDFReadingAnchor,
    sentenceIndex?: number,
    options: { smooth?: boolean; center?: boolean } = {},
  ) => {
    const formula = equationNumbers.byNumber.get(anchor.blockId),
      number = sourceBlocksById.get(anchor.blockId);
    if (formula && number) {
      // The translated formula includes its number, while PDF.js can anchor
      // on the separate number. Preserve the same source-page vertical point.
      let sourceY = number.bounds.y + anchor.fraction * number.bounds.height;
      let gap = anchor.gap;
      const next = gap && sourceBlocksById.get(gap.nextBlockId);
      const numberEnd = number.bounds.y + number.bounds.height;
      if (gap && next?.page === number.page && next.bounds.y > numberEnd) {
        sourceY = numberEnd + gap.fraction * (next.bounds.y - numberEnd);
        const formulaEnd = formula.bounds.y + formula.bounds.height;
        gap =
          sourceY > formulaEnd && next.bounds.y > formulaEnd
            ? {
                ...gap,
                fraction: (sourceY - formulaEnd) / (next.bounds.y - formulaEnd),
              }
            : undefined;
      }
      anchor = {
        ...anchor,
        blockId: formula.id,
        gap,
        fraction: Math.max(
          0,
          Math.min(1, (sourceY - formula.bounds.y) / formula.bounds.height),
        ),
      };
    }
    const node = targetNode(anchor.blockId),
      host = pane.current;
    if (!node || !host) return;
    control.current.following("translation");
    const target =
      sentenceIndex === undefined
        ? node
        : (node.querySelector<HTMLElement>(
            `[data-sentence="${sentenceIndex}"]`,
          ) ?? node);
    const r = target.getBoundingClientRect(),
      v = host.getBoundingClientRect();
    let offset = sentenceIndex === undefined ? r.height * anchor.fraction : 0;
    if (anchor.gap && sentenceIndex === undefined && !options.center) {
      const next = targetNode(
        equationNumbers.byNumber.get(anchor.gap.nextBlockId)?.id ??
          anchor.gap.nextBlockId,
      );
      const nextRect = next?.getBoundingClientRect();
      if (nextRect && next !== node && nextRect.top > r.bottom)
        offset =
          r.height +
          (nextRect.top - r.bottom) *
            Math.max(0, Math.min(1, anchor.gap.fraction));
    }
    const top =
      host.scrollTop +
      r.top -
      v.top -
      (options.center
        ? Math.max(0, (v.height - r.height) / 2)
        : v.height * 0.5 - offset);
    if (
      translationMotion.current.moving &&
      translationMotion.current.blockId === anchor.blockId &&
      !options.center
    )
      return;
    cancelTranslationMotion();
    if (!options.smooth) {
      host.scrollTop = top;
      return;
    }
    const motion = translationMotion.current;
    const operation = motion.operation;
    motion.moving = true;
    motion.blockId = anchor.blockId;
    return animatePDFScroll(
      host,
      options.center
        ? host.scrollLeft + r.left - v.left + r.width / 2 - host.clientWidth / 2
        : host.scrollLeft,
      top,
      () => operation !== motion.operation || pane.current !== host,
      () => {},
    ).finally(() => {
      if (operation === motion.operation) {
        motion.moving = false;
        // Ignore the last programmatic scroll event; fresh input releases this.
        control.current.following("translation");
      }
    });
  };
  const focusBlock = (block: PDFBlock, origin: "source" | "translation") => {
    if (isNativeMode(mode)) {
      void engine
        ?.focusBlock?.(block.id, "source")
        .catch((e) => toast.error(e.message));
      return Promise.resolve();
    }
    input(origin);
    const motion = explicitFocus.current;
    const operation = motion.operation;
    motion.moving = true;
    setFocusedBlock(block.id);
    const anchor = { blockId: block.id, fraction: 0.5 };
    recordReading(anchor);
    // Both panels center their own geometry; a tall translation must not shift
    // a short original away from its center (or vice versa).
    const source =
      mode !== "translation" ? engine?.focusBlock?.(block.id, mode) : undefined;
    const translated =
      mode !== "source"
        ? followTranslation(anchor, undefined, { smooth: true, center: true })
        : undefined;
    const completed = Promise.all([source, translated])
      .catch((e) => toast.error(e.message))
      .finally(() => {
        if (operation === motion.operation) {
          motion.moving = false;
          setFocusedBlock(undefined);
          control.current.following(origin);
        }
      });
    events.location(
      { type: "pdf", page: block.page, x: block.bounds.x, y: block.bounds.y },
      block.page /
        (engine?.getPageCount?.() || Math.max(1, ...blocks.map((b) => b.page))),
    );
    return completed;
  };
  const focusTranslation = (block: PDFBlock) => {
    void focusBlock(block, "translation");
  };
  const locationBlock = (location: DocumentLocation) => {
    if (location.type !== "pdf") return;
    const readable = state.current.blocks.filter(
      (b) => !isPDFPageDecoration(b),
    );
    const linked =
      location.translation?.blockId ??
      location.sourceAnchors?.[0]?.blockId ??
      location.sentenceLink?.parts[0]?.blockId;
    const page = readable.filter((b) => b.page === location.page);
    // Saved selections carry rects rather than x/y; the first marked line
    // decides the paragraph, never the page origin.
    const rect = location.rects?.[0] ?? location.sourceAnchors?.[0]?.bounds;
    const covering =
      rect &&
      page
        .map((b) => ({ block: b, area: overlap(rect, b.bounds) }))
        .filter((c) => c.area > 0)
        .sort((a, b) => b.area - a.area)[0]?.block;
    const x = location.x ?? (rect ? rect.x + rect.width / 2 : 0),
      y = location.y ?? (rect ? rect.y + rect.height / 2 : 0);
    return (
      readable.find((b) => b.id === linked) ??
      covering ??
      page.sort((a, b) => {
        const distance = (block: PDFBlock) =>
          Math.max(
            block.bounds.y - y,
            y - block.bounds.y - block.bounds.height,
            0,
          ) +
          Math.max(
            block.bounds.x - x,
            x - block.bounds.x - block.bounds.width,
            0,
          ) *
            2;
        return distance(a) - distance(b);
      })[0]
    );
  };
  const go = async (location: DocumentLocation, target = engine) => {
    input(mode === "translation" ? "translation" : "source");
    await target?.goTo(location);
    if (location.type !== "pdf") return;
    const block = locationBlock(location);
    if (block) {
      const anchor = {
        blockId: block.id,
        fraction:
          location.y === undefined
            ? 0
            : Math.max(
                0,
                Math.min(
                  1,
                  (location.y - block.bounds.y) / (block.bounds.height || 1),
                ),
              ),
      };
      recordReading(anchor);
      followTranslation(anchor, location.translation?.sentenceIndexes[0]);
      state.current.events.location(
        location,
        block.page / Math.max(1, ...state.current.blocks.map((b) => b.page)),
      );
    }
  };
  const focus = async (location: DocumentLocation) => {
    const block = locationBlock(location);
    const completed = block
      ? focusBlock(block, mode === "translation" ? "translation" : "source")
      : go(location);
    const operation = explicitFocus.current.operation;
    await completed;
    if (operation !== explicitFocus.current.operation) return;
    if (location.type === "pdf" && mode !== "translation")
      engine?.flashReference?.(location, location.quote ?? "");
  };
  // Keep the public adapter usable by TOC, notes and page navigation in all modes.
  const facade = useRef<ReaderAdapter | undefined>(undefined);
  const detachAdapter = () => {
    facade.current = undefined;
    nativeAdapter.current = undefined;
    setEngine(undefined);
    onAdapterDetached?.();
  };
  const originalNavigation = useRef<
    | {
        owner: ReaderAdapter;
        finish: (original?: ReaderAdapter) => void;
      }
    | undefined
  >(undefined);
  const endOriginalNavigation = useCallback(() => {
    originalNavigation.current?.finish();
    originalNavigation.current = undefined;
  }, []);
  useEffect(() => endOriginalNavigation, [doc.id, endOriginalNavigation]);
  const outline = useRef<TOCItem[]>([]);
  const actions = useRef({ go, focus });
  actions.current = { go, focus };
  useEffect(() => {
    if (!root.current || !engine) return;
    return installCitationHover(
      root.current,
      async (blockId, label) => {
        if (label.startsWith("figure:")) {
          const block = figureTarget(blocks, label.slice(7));
          return block
            ? {
                type: "pdf" as const,
                page: block.page,
                x: block.bounds.x,
                y: block.bounds.y,
              }
            : undefined;
        }
        return (
          (await engine.resolveCitation?.(blockId, label)) ??
          numberedReference(blocks, label)
        );
      },
      async (location, anchor) => {
        await engine.previewCitation?.(location, anchor);
      },
      () => engine.hideCitationPreview?.(),
    );
  }, [engine, blocks, mode]);
  const visitCitation = async (blockId: string, label: string) => {
    try {
      if (label.startsWith("figure:")) {
        const block = figureTarget(blocks, label.slice(7));
        if (!block) throw new Error(`未找到图 ${label.slice(7)} 的图片位置`);
        if (facade.current) events.internalLink?.(facade.current.getLocation());
        focusBlock(block, "translation");
        return;
      }
      const target =
        (await engine?.resolveCitation?.(blockId, label)) ??
        numberedReference(blocks, label);
      if (!target) throw new Error(`未找到参考论文 [${label}] 的跳转位置`);
      if (facade.current) events.internalLink?.(facade.current.getLocation());
      await go(target);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const translationActions = useRef({
    focusTranslation,
    hover,
    visitCitation,
    translate,
  });
  translationActions.current = {
    focusTranslation,
    hover,
    visitCitation,
    translate,
  };
  const onCitation = useCallback((blockId: string, label: string) => {
    void translationActions.current.visitCitation(blockId, label);
  }, []);
  const ready = (adapter: ReaderAdapter, toc: TOCItem[]) => {
    outline.current = toc;
    setEngineDocument(doc.id);
    setEngine(adapter);
    facade.current = new Proxy(adapter, {
      get(target, key) {
        if (key === "prepareAnnotation")
          return async (value: ReaderSelection) => {
            if (value.location.type !== "pdf") return value;
            // Keep navigation metadata, but never persist a cross-side mark.
            const { sentenceLink: _, ...location } = value.location;
            return { ...value, location };
          };
        if (key === "goTo")
          return (l: DocumentLocation) => actions.current.go(l, target);
        if (key === "search")
          return async (query: string) => {
            const current = state.current;
            if (!current.blocks.length) return target.search(query);
            const found = searchPDFBlocks(
              query,
              current.blocks,
              current.translations,
            );
            const parsedPages = new Set(
              current.blocks.map((block) => block.page),
            );
            if (
              parsedPages.size >= (target.getPageCount?.() ?? parsedPages.size)
            )
              return found;
            const unparsed = (await target.search(query)).filter(
              (result) =>
                result.location.type === "pdf" &&
                !parsedPages.has(result.location.page),
            );
            return [...found, ...unparsed].slice(0, 100);
          };
        if (key === "focusLocation")
          return (l: DocumentLocation) => actions.current.focus(l);
        if (key === "next" || key === "previous")
          return () => {
            if (!state.current.blocks.length) return target[key]();
            const block = state.current.blocks.find(
              (b) => b.id === reading.current?.blockId,
            );
            const current =
              block?.page ?? (target.getLocation() as { page: number }).page;
            return actions.current.go({
              type: "pdf",
              page: Math.max(1, current + (key === "next" ? 1 : -1)),
            });
          };
        const readingTranslation =
          state.current.mode === "translation" ||
          (state.current.mode === "parallel" && side.current === "translation");
        if (key === "getLocation" && readingTranslation)
          return () =>
            locationAtReadingAnchor(
              state.current.sourceBlocksById,
              reading.current,
            ) ?? target.getLocation();
        if (key === "isNear" && readingTranslation)
          return (location: DocumentLocation) => {
            const block = locationBlock(location),
              host = pane.current;
            const node = block && targetNode(block.id);
            if (!block || !host || !node || location.type !== "pdf")
              return false;
            const rect = node.getBoundingClientRect(),
              view = host.getBoundingClientRect();
            const fraction = Math.max(
              0,
              Math.min(
                1,
                ((location.y ?? block.bounds.y) - block.bounds.y) /
                  (block.bounds.height || 1),
              ),
            );
            return (
              Math.abs(
                rect.top + rect.height * fraction - view.top - view.height / 2,
              ) <
              view.height / 4
            );
          };
        if (key === "clearSelection")
          return () => {
            window.getSelection()?.removeAllRanges();
            selection.current = null;
            void target.focusSentences?.("", []);
            state.current.events.selection(null);
            target.clearSelection();
          };
        if (key === "getSelection")
          return () => selection.current ?? target.getSelection();
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    onReady(facade.current, toc);
    if (originalNavigation.current && mode === "source") {
      nativeLocation.current.restoreSource = false;
      originalNavigation.current.finish(adapter);
      return;
    }
    if (
      nativeLocation.current.restoreSource &&
      nativeLocation.current.location
    ) {
      nativeLocation.current.restoreSource = false;
      void adapter
        .goTo(nativeLocation.current.location)
        .catch((e) => toast.error(e.message));
    }
  };
  const nativeReady = (adapter: ReaderAdapter, toc: TOCItem[]) => {
    let exposed = adapter;
    if (mode === "native-translation") {
      let original: Promise<ReaderAdapter | undefined> | undefined;
      const navigationTarget = (source: boolean) => {
        if (!root.current || state.current.documentId !== doc.id) return;
        if (originalNavigation.current?.owner === exposed) return original;
        if (nativeAdapter.current?.adapter !== exposed) return;
        if (!source) return adapter;
        original = new Promise((finish) => {
          originalNavigation.current = { owner: exposed, finish };
        });
        changeMode("source");
        return original;
      };
      const navigation: Pick<
        ReaderAdapter,
        "focusReference" | "flashReference" | "goTo" | "focusLocation"
      > = {
        async focusReference(location, text) {
          const target = await navigationTarget(true);
          return (await target?.focusReference?.(location, text)) ?? false;
        },
        flashReference(location, text) {
          void Promise.resolve(navigationTarget(true))
            .then((target) => target?.flashReference?.(location, text))
            .catch((error) => toast.error(error.message));
        },
        async goTo(location) {
          const target = await navigationTarget(needsOriginalPage(location));
          await target?.goTo(location);
        },
        async focusLocation(location) {
          const target = await navigationTarget(needsOriginalPage(location));
          if (target?.focusLocation) await target.focusLocation(location);
          else await target?.goTo(location);
        },
      };
      exposed = new Proxy(adapter, {
        get(target, key) {
          if (Object.hasOwn(navigation, key))
            return Reflect.get(navigation, key);
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    nativeAdapter.current = { documentId: doc.id, adapter: exposed };
    outline.current = toc;
    facade.current = exposed;
    setEngineDocument(doc.id);
    setEngine(adapter);
    onReady(exposed, toc);
  };
  useEffect(() => {
    if (!engine) return;
    hoverOwner.current = undefined;
    setHoveredBlock(undefined);
    engine.hoverBlock?.(null);
    const previous = previousMode.current;
    previousMode.current = mode;
    if (isNativeMode(mode)) return;
    if (isNativeMode(previous)) {
      if (mode === "translation" && reading.current)
        followTranslation(reading.current);
      return;
    }
    let cancelled = false;
    selection.current = null;
    events.selection(null);
    window.getSelection()?.removeAllRanges();
    void engine.focusSentences?.("", []);
    if (previous !== mode && mode === "parallel") {
      const block = blocks.find(
        (b) => b.id === (enteringParallel.current ?? reading.current?.blockId),
      );
      enteringParallel.current = undefined;
      if (block) {
        // Panel resize commits and ResizeObserver callbacks can follow this effect.
        // Keep the selected block fixed until both panes have their new geometry.
        const motion = explicitFocus.current;
        const operation = motion.operation;
        motion.moving = true;
        let frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            if (cancelled || operation !== motion.operation) return;
            focusBlock(
              block,
              previous === "translation" ? "translation" : "source",
            );
          });
        });
        return () => {
          cancelled = true;
          cancelAnimationFrame(frame);
          if (operation === motion.operation) motion.moving = false;
          engine.hoverBlock?.(null);
        };
      }
    }
    const restore = async () => {
      // A focused block zooms past the pane so the paragraph fits; returning
      // to the page view must restore the page-level zoom and insets first.
      if (previous !== mode && mode === "source") engine.exitBlockFocus?.();
      if (
        previous !== mode &&
        mode !== "translation" &&
        reading.current &&
        syncEnabledRef.current
      )
        await engine.followBlock?.(reading.current);
      if (cancelled) return;
      if (!cancelled && mode !== "source" && reading.current)
        followTranslation(reading.current);
    };
    void restore().catch((e) => {
      if (!cancelled) toast.error(e.message);
    });
    return () => {
      cancelled = true;
      engine.hoverBlock?.(null);
    };
  }, [mode, engine]);
  const leftOpen = sidebarsOpen?.left ?? true;
  const rightOpen = sidebarsOpen?.right ?? true;
  const previousSidebars = useRef({ left: leftOpen, right: rightOpen });
  useLayoutEffect(() => {
    const previous = previousSidebars.current;
    previousSidebars.current = { left: leftOpen, right: rightOpen };
    if (
      !engine ||
      isNativeMode(mode) ||
      !((previous.left && !leftOpen) || (previous.right && !rightOpen))
    )
      return;
    // Capture before Workspace's layout effect collapses the panels.
    const origin =
      mode === "translation"
        ? "translation"
        : mode === "source"
          ? "source"
          : side.current;
    const id = centerBlock(origin);
    const block = blocks.find((block) => block.id === id);
    if (!block) return;
    const motion = explicitFocus.current;
    const operation = motion.operation;
    motion.moving = true;
    let settledFrames = 0;
    let frame = requestAnimationFrame(function settle() {
      if (operation !== motion.operation) return;
      // Workspace owns the transition marker, including interrupted transitions.
      // Allow ResizeObserver and PDF.js to commit the final width afterwards.
      if (root.current?.closest("[data-toggling]")) settledFrames = 0;
      else settledFrames++;
      if (settledFrames < 2) frame = requestAnimationFrame(settle);
      else void focusBlock(block, origin);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (operation === motion.operation) motion.moving = false;
    };
  }, [leftOpen, rightOpen, engine, mode, doc.id]);
  useEffect(() => {
    const release = () => {
      selecting.current = false;
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);
  const input = (active: typeof side.current) => {
    cancelTranslationMotion();
    if (explicitFocus.current.moving || active === "translation")
      engine?.cancelBlockFocus?.();
    explicitFocus.current.operation++;
    explicitFocus.current.moving = false;
    setFocusedBlock(undefined);
    side.current = active;
    control.current.input(active);
  };
  const sourceSelection = (value: ReaderSelection | null) => {
    if (side.current !== "source") return;
    selection.current = value;
    events.selection(value);
  };
  const translatedSelection = () => {
    selecting.current = false;
    const selected = window.getSelection();
    if (!selected?.rangeCount || !selected.toString().trim() || !pane.current)
      return;
    const value = captureTranslationSelection(
      pane.current,
      selected.getRangeAt(0),
      blocks,
      translations,
    );
    if (!value) return;
    selection.current = value.selection;
    events.selection(value.selection);
  };
  const translatedScroll = () => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      if (
        selecting.current ||
        explicitFocus.current.moving ||
        translationMotion.current.moving ||
        !pane.current ||
        !control.current.canFollow("translation")
      )
        return;
      const v = pane.current.getBoundingClientRect(),
        y = v.top + v.height * 0.5;
      // Sections follow normal document flow. Read only the rectangles needed
      // to locate the center, even when the paper contains thousands of blocks.
      const nodes = translationNodes.current;
      let first = 0,
        end = nodes.length;
      while (first < end) {
        const middle = Math.floor((first + end) / 2);
        if (nodes[middle].getBoundingClientRect().bottom > y) end = middle;
        else first = middle + 1;
      }
      const node = nodes[first];
      if (!node) return;
      const r = node.getBoundingClientRect();
      let anchor: PDFReadingAnchor = {
        blockId: node.dataset.translationBlock!,
        fraction: Math.max(0, Math.min(1, (y - r.top) / (r.height || 1))),
      };
      if (first > 0 && y < r.top) {
        const previous = nodes[first - 1],
          before = previous.getBoundingClientRect();
        if (y >= before.bottom && r.top > before.bottom)
          anchor = {
            blockId: previous.dataset.translationBlock!,
            fraction: 1,
            gap: {
              nextBlockId: node.dataset.translationBlock!,
              fraction: (y - before.bottom) / (r.top - before.bottom),
            },
          };
      }
      recordReading(anchor);
      const location = locationAtReadingAnchor(sourceBlocksById, anchor);
      if (location)
        events.location(
          location,
          location.page / (engine?.getPageCount?.() || lastPage),
        );
      if (mode === "parallel" && syncEnabledRef.current) {
        control.current.following("source");
        void engine?.followBlock?.(anchor, { smooth: false });
      }
    });
  };
  const centerBlock = (origin: "source" | "translation") => {
    const host =
      origin === "translation"
        ? pane.current
        : root.current?.querySelector<HTMLElement>(".pdf-container");
    let nearest: string | undefined;
    let distance = Infinity;
    if (host) {
      const view = host.getBoundingClientRect();
      const x = view.left + view.width / 2,
        y = view.top + view.height / 2;
      for (const block of visibleBlocks) {
        let rect: DOMRect | undefined;
        if (origin === "translation")
          rect = targetNode(block.id)?.getBoundingClientRect();
        else {
          const page = host
            .querySelector<HTMLElement>(
              `.page[data-page-number="${block.page}"]`,
            )
            ?.getBoundingClientRect();
          if (page)
            rect = new DOMRect(
              page.left + block.bounds.x * page.width,
              page.top + block.bounds.y * page.height,
              block.bounds.width * page.width,
              block.bounds.height * page.height,
            );
        }
        if (
          !rect?.height ||
          !rect.width ||
          rect.bottom <= view.top ||
          rect.top >= view.bottom ||
          rect.right <= view.left ||
          rect.left >= view.right
        )
          continue;
        const d =
          Math.max(rect.left - x, x - rect.right, 0) * 2 +
          Math.max(rect.top - y, y - rect.bottom, 0);
        if (d < distance) {
          distance = d;
          nearest = block.id;
        }
      }
    }
    return nearest;
  };
  const changeMode = (
    nextContent: PDFReadingContent,
    nextFormat = format,
    fromBlock?: PDFBlock,
  ) => {
    const value = readingMode(nextContent, nextFormat);
    setFormat(nextFormat);
    if (mode === value) {
      if (fromBlock) {
        setPopup(undefined);
        void focusBlock(fromBlock, "source");
      }
      return;
    }
    if (fromBlock) recordReading({ blockId: fromBlock.id, fraction: 0 });
    if (value !== "source") endOriginalNavigation();
    if (isNativeMode(mode) || isNativeMode(value)) {
      if (fromBlock) {
        nativeLocation.current.location = {
          type: "pdf",
          page: fromBlock.page,
          x: fromBlock.bounds.x,
          y: fromBlock.bounds.y,
        };
      } else if (!isNativeMode(mode) && engineDocument === doc.id) {
        nativeLocation.current.location =
          facade.current?.getLocation() ?? nativeLocation.current.location;
      } else if (
        nativeAdapter.current?.documentId === doc.id &&
        facade.current === nativeAdapter.current.adapter
      ) {
        // Page events omit movement within the same page. Read the ready native
        // viewport before unmounting; a loading view has no live adapter yet.
        try {
          nativeLocation.current.location =
            nativeAdapter.current.adapter.getLocation();
        } catch {
          // A revision reload may already have disposed it; keep the last event.
        }
      }
      detachAdapter();
      nativeLocation.current.restoreSource =
        isNativeMode(mode) && !isNativeMode(value);
      if (
        isNativeMode(mode) &&
        nativeLocation.current.location?.type === "pdf"
      ) {
        const location = nativeLocation.current.location;
        const block = locationBlock(location);
        if (block)
          recordReading({
            blockId: block.id,
            fraction: Math.max(
              0,
              Math.min(
                1,
                ((location.y ?? block.bounds.y) - block.bounds.y) /
                  (block.bounds.height || 1),
              ),
            ),
          });
      }
    }
    if (value === "parallel" && mode !== "parallel") {
      enteringParallel.current =
        fromBlock?.id ??
        centerBlock(mode === "translation" ? "translation" : "source") ??
        reading.current?.blockId;
    }
    input(value === "translation" ? "translation" : "source");
    setPopup(undefined);
    setContent(nextContent);
    // A half-width source pane needs fit-width; a 100% page would be clipped.
    if (value === "parallel" || value === "native") events.zoom?.("width");
  };
  const activePopup = popup && byId.get(popup.block.id);
  const toggleSync = () => {
    const enabled = !syncEnabledRef.current;
    syncEnabledRef.current = enabled;
    setSyncEnabled(enabled);
    // Stop pending follow animations before changing the synchronization policy.
    input(side.current);
    engine?.cancelBlockFocus?.();
    const anchor = reading.current;
    if (!enabled || mode !== "parallel" || !anchor) return;
    if (side.current === "source") {
      void followTranslation(anchor, undefined, { smooth: true });
    } else {
      control.current.following("source");
      void engine?.followBlock?.(anchor).catch((e) => toast.error(e.message));
    }
  };
  const autoCenterButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            data-active={syncEnabled || undefined}
            className={syncEnabled ? "toolbar-icon-active" : undefined}
            aria-label={syncEnabled ? "取消同步效果" : "开启同步效果"}
            aria-pressed={syncEnabled}
            onClick={toggleSync}
          />
        }
      >
        <Crosshair />
      </TooltipTrigger>
      <TooltipContent>
        {syncEnabled ? "取消同步效果" : "开启同步效果"}
      </TooltipContent>
    </Tooltip>
  );
  // Position reports update the parent without changing paragraph content. Keep
  // that path out of Markdown rendering and annotation-derived block markup.
  const translatedBlocks = useMemo(
    () =>
      mode !== "source" &&
      !isNativeMode(mode) &&
      visibleBlocks.map((block) => {
        const translated = byId.get(block.id),
          noteIndexes = annotations.flatMap((a) => {
            const mark =
              a.location.type === "pdf" ? a.location.translation : undefined;
            return mark
              ? (mark.ranges ?? [mark])
                  .filter(
                    (r) =>
                      r.blockId === block.id &&
                      r.sourceHash === translated?.sourceHash,
                  )
                  .flatMap((r) => r.sentenceIndexes)
              : [];
          });
        return (
          <section
            key={block.id}
            data-translation-block={block.id}
            data-block-kind={block.image ? "image" : "text"}
            data-label={block.label}
            data-search-hit={searchBlockIds.includes(block.id) || undefined}
            tabIndex={0}
            onClick={(event) => {
              const pressed = pressedBlock.current;
              pressedBlock.current = undefined;
              if (
                (event.target as Element).closest(
                  "a, button, input, textarea, select, [role=button], [contenteditable=true]",
                ) ||
                window.getSelection()?.toString().trim() ||
                (event.detail > 0 &&
                  (!pressed ||
                    pressed.id !== block.id ||
                    Math.hypot(
                      event.clientX - pressed.x,
                      event.clientY - pressed.y,
                    ) > 5))
              )
                return;
              translationActions.current.focusTranslation(block);
            }}
            onKeyDown={(event) => {
              if (
                event.target === event.currentTarget &&
                (event.key === "Enter" || event.key === " ")
              ) {
                event.preventDefault();
                translationActions.current.focusTranslation(block);
              }
            }}
            onPointerEnter={(event) => {
              if (!event.buttons && !selecting.current)
                translationActions.current.hover("translation", block.id);
            }}
            onPointerMove={(event) => {
              if (!event.buttons && !selecting.current)
                translationActions.current.hover("translation", block.id);
            }}
            onPointerLeave={() =>
              translationActions.current.hover("translation")
            }
            className={noteIndexes.length ? "translation-annotated" : ""}
          >
            <TranslationText
              block={block}
              onCitation={onCitation}
              formulaNumber={equationNumbers.byFormula.get(block.id)}
              translation={translated}
              documentId={doc.id}
              renderImage={blockImages?.url}
              retry={() => void translationActions.current.translate(block.id)}
              paused={processing?.enabled === false}
              processing={processing}
            />
            {noteIndexes.length > 0 && (
              <span
                className="translation-note-indicator"
                title="此段有已保存的标注"
                aria-label="此段有已保存的标注"
              />
            )}
          </section>
        );
      }),
    [
      mode,
      visibleBlocks,
      byId,
      annotations,
      searchBlockIds,
      equationNumbers,
      doc.id,
      blockImages,
      processing,
      onCitation,
    ],
  );
  const toolbar = (
    <div className="translation-toolbar">
      <div className="reading-translation-actions">
        {!autoCenterHost && !isNativeMode(mode) && autoCenterButton}
        <AssistanceControls
          documentId={doc.id}
          processing={processing}
          library={doc.library}
          chapter={() => {
            const location = facade.current?.getLocation();
            if (location?.type !== "pdf") return undefined;
            return chapterRange(
              outline.current,
              location.page,
              engine?.getPageCount?.() ||
                Math.max(1, ...blocks.map((b) => b.page)),
              headingPages(blocks),
            );
          }}
        />
      </div>
      <PDFReadingControls
        content={content}
        format={format}
        onContentChange={changeMode}
        onFormatChange={(next) => changeMode(content, next)}
      />
    </div>
  );
  return (
    <div
      className="pdf-reading"
      ref={root}
      data-theme={theme.mode}
      data-dark-contrast={theme.pdfDarkContrast ?? "soft"}
    >
      {autoCenterHost &&
        !isNativeMode(mode) &&
        createPortal(autoCenterButton, autoCenterHost)}
      {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
      {mode === "translation" && (
        <div className="pdf-reading-controls">
          <div className="pdf-page-navigation">{pageNavigation}</div>
        </div>
      )}
      {isNativeMode(mode) ? (
        <NativePDFReadingView
          key={`${doc.id}:${mode}`}
          split={split}
          layout={
            mode === "native-translation" ? "translation-only" : "side-by-side"
          }
          document={doc}
          theme={theme}
          annotations={annotations}
          blocks={blocks}
          translations={translations}
          pageNavigation={pageNavigation}
          initialLocation={nativeLocation.current.location}
          onReady={nativeReady}
          onRegenerate={(location) => {
            nativeLocation.current.location = location;
            detachAdapter();
          }}
          events={{
            ...events,
            location: (location, percentage) => {
              nativeLocation.current.location = location;
              events.location(location, percentage);
            },
          }}
          onUseFlow={() => changeMode(content, "flow")}
        />
      ) : (
        <TranslationPanes
          mode={mode}
          split={split}
          sourceLabel="原页"
          translationLabel="译文"
          source={
            <div
              className="translation-source"
              inert={mode === "translation"}
              onWheelCapture={() => input("source")}
              onPointerDownCapture={() => input("source")}
              onKeyDownCapture={() => input("source")}
            >
              <InterleafView
                document={doc}
                theme={theme}
                annotations={sourceAnnotations}
                blocks={blocks}
                onReady={ready}
                onOpenError={endOriginalNavigation}
                events={{
                  ...events,
                  selection: sourceSelection,
                  blockFocus: (block) => {
                    void focusBlock(block, "source");
                  },
                  location: (location, percentage) => {
                    if (
                      state.current.mode !== "translation" &&
                      side.current === "source"
                    )
                      events.location(location, percentage);
                  },
                  get readingAnchor() {
                    const canRecord = () =>
                      !(
                        !sourceActive.current ||
                        state.current.documentId !== doc.id ||
                        state.current.mode === "translation" ||
                        isNativeMode(state.current.mode) ||
                        explicitFocus.current.moving ||
                        !control.current.canFollow("source") ||
                        selecting.current
                      );
                    if (!canRecord()) return undefined;
                    return (anchor: PDFReadingAnchor) => {
                      if (!canRecord()) return;
                      recordReading(anchor);
                      if (
                        state.current.mode === "parallel" &&
                        syncEnabledRef.current
                      )
                        followTranslation(anchor);
                    };
                  },
                  blockHover: (block) => {
                    if (mode === "parallel") hover("source", block?.id);
                  },
                  blockAction: (block, action) => {
                    if (action !== "translate") {
                      events.blockAction?.(block, action);
                      return;
                    }
                    const button = root.current?.querySelector<HTMLElement>(
                      `[data-block-id="${block.id}"] [data-block-action="translate"]`,
                    );
                    setPopup({
                      block,
                      rect:
                        button?.getBoundingClientRect() ??
                        root.current!.getBoundingClientRect(),
                    });
                  },
                }}
              />
              {mode !== "translation" && (
                <div className="pdf-reading-controls">
                  <div className="pdf-page-navigation">{pageNavigation}</div>
                </div>
              )}
            </div>
          }
          translation={
            mode !== "source" && (
              <div
                className="translation-document"
                ref={pane}
                tabIndex={0}
                aria-label="论文译文"
                onScroll={() => {
                  hover("translation");
                  translatedScroll();
                }}
                onPointerLeave={() => hover("translation")}
                onWheelCapture={() => input("translation")}
                onPointerDownCapture={(event) => {
                  const section = (
                    event.target as Element
                  ).closest<HTMLElement>("[data-translation-block]");
                  pressedBlock.current =
                    section && event.button === 0
                      ? {
                          id: section.dataset.translationBlock!,
                          x: event.clientX,
                          y: event.clientY,
                        }
                      : undefined;
                  input("translation");
                  hover("translation");
                  selecting.current = !!section;
                  selection.current = null;
                  events.selection(null);
                  void engine?.focusSentences?.("", []);
                }}
                onPointerUp={translatedSelection}
                onDoubleClick={(event) => {
                  // Select the translated sentence; untranslated text falls
                  // back to the sentence around the word.
                  const target = event.target as Element;
                  const sentence = target.closest(".translation-sentence");
                  const selected = window.getSelection();
                  if (sentence && selected) {
                    const range = document.createRange();
                    range.selectNodeContents(sentence);
                    selected.removeAllRanges();
                    selected.addRange(range);
                  } else {
                    const section = target.closest("section");
                    if (section) selectSentence(selected, section);
                  }
                  translatedSelection();
                }}
                onKeyDownCapture={() => input("translation")}
                onKeyUp={translatedSelection}
                style={{
                  fontSize: `${theme.translationFontSize ?? 1}rem`,
                  fontFamily: translationFont(theme.translationFontFamily),
                  fontWeight:
                    (theme.translationFontWeight ??
                      defaultTheme.translationFontWeight) === "bold"
                      ? 600
                      : undefined,
                  lineHeight: theme.lineHeight,
                }}
              >
                <TranslationJobStatus
                  processing={processing}
                  error={error}
                  retry={() =>
                    void api
                      .process(doc.id)
                      .catch((e) => toast.error(e.message))
                  }
                />
                {!visibleBlocks.length && (
                  <p role="status">
                    {doc.library === "books"
                      ? "尚未翻译任何章节，可在工具栏翻译本章。"
                      : "正文仍在解析中，完成的段落会在这里显示。"}
                  </p>
                )}
                {translatedBlocks}
              </div>
            )
          }
        />
      )}
      <Popover
        open={!!popup}
        onOpenChange={(open) => {
          if (!open) setPopup(undefined);
        }}
      >
        <PopoverContent
          anchor={
            popup ? { getBoundingClientRect: () => popup.rect } : undefined
          }
          className="translation-popover"
          side="bottom"
          align="end"
        >
          {popup && (
            <>
              <TranslationText
                block={popup.block}
                onCitation={onCitation}
                formulaNumber={equationNumbers.byFormula.get(popup.block.id)}
                translation={activePopup}
                documentId={doc.id}
                renderImage={blockImages?.url}
                retry={() => void translate(popup.block.id)}
                paused={processing?.enabled === false}
                processing={processing}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => changeMode("parallel", format, popup.block)}
              >
                进入双栏对照
              </Button>
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
