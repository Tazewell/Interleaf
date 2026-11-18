import { useLayoutEffect, useMemo, useRef, type ComponentProps } from "react";
import type {
  Annotation,
  DocumentLocation,
  ReaderAdapter,
  ReaderEvents,
  TOCItem,
} from "@interleaf/core";
import { InterleafView } from "../InterleafView";
import { TranslationPanes, type TranslationSplit } from "./TranslationPanes";
import { linkNativePDFPanes, type NativePane } from "./native-pane-scroll";

type LinkedScroll = ReturnType<typeof linkNativePDFPanes>;
type PaneProps = ComponentProps<typeof InterleafView>;
const onSource = (annotation: Annotation) =>
  annotation.location.type !== "pdf" || !annotation.location.translation;

function pairedReader(
  source: ReaderAdapter,
  translation: ReaderAdapter,
  scroll: LinkedScroll,
): ReaderAdapter {
  const readers = { source, translation };
  const drive = (side: NativePane) => {
    scroll.activate(side);
    return readers[side];
  };
  const targetSide = (location: DocumentLocation): NativePane =>
    location.type === "pdf" && location.translation ? "translation" : "source";
  const actions: Partial<ReaderAdapter> = {
    getLocation: () => readers[scroll.active].getLocation(),
    getContext: (at) =>
      source.getContext(at ?? readers[scroll.active].getLocation()),
    isNear: (location) => readers[scroll.active].isNear?.(location) ?? false,
    next: () => readers[scroll.active].next(),
    previous: () => readers[scroll.active].previous(),
    async goTo(location) {
      await drive(targetSide(location)).goTo(location);
      scroll.sync();
    },
    async focusLocation(location, side = targetSide(location)) {
      const reader = drive(side);
      if (reader.focusLocation) await reader.focusLocation(location);
      else await reader.goTo(location);
      scroll.sync();
    },
    async focusReference(location, text) {
      return (await drive("source").focusReference?.(location, text)) ?? false;
    },
    flashReference: (location, text) =>
      drive("source").flashReference?.(location, text),
    focusBlock: async (id, layout) => {
      await drive("source").focusBlock?.(id, layout);
    },
    searchSource: (query) => source.search(query),
    async search(query) {
      const results = await Promise.all(
        (["source", "translation"] as const).map(async (side) =>
          (await readers[side].search(query)).map((hit) => ({
            ...hit,
            id: side + "-" + hit.id,
            side,
          })),
        ),
      );
      return results
        .flat()
        .sort(
          (a, b) =>
            (a.location.type === "pdf" ? a.location.page : 0) -
            (b.location.type === "pdf" ? b.location.page : 0),
        )
        .slice(0, 100);
    },
    getSelection: () => readers[scroll.active].getSelection(),
    clearSelection() {
      source.clearSelection();
      translation.clearSelection();
    },
    async prepareAnnotation(selection) {
      const location = selection.location;
      // Unmapped translated quotes must still pass the translated reader's anchor checks.
      const reader =
        location.type === "pdf" &&
        (location.translation || !location.rects?.length)
          ? translation
          : source;
      return (await reader.prepareAnnotation?.(selection)) ?? selection;
    },
    async highlight(annotations) {
      await Promise.all([
        source.highlight(annotations.filter(onSource)),
        translation.highlight(annotations),
      ]);
    },
    async setTheme(theme) {
      await Promise.all([source.setTheme(theme), translation.setTheme(theme)]);
    },
    async destroy() {
      scroll.destroy();
      await Promise.all([source.destroy(), translation.destroy()]);
    },
  };
  // Original-document operations such as image extraction, citations and TOC belong to the source.
  return new Proxy(source, {
    get(target, key) {
      if (Object.hasOwn(actions, key)) return Reflect.get(actions, key);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function NativePDFPanes({
  nativeReading,
  events,
  onReady,
  annotations,
  split,
  ...props
}: PaneProps & { split: TranslationSplit }) {
  const sourceHost = useRef<HTMLDivElement>(null),
    translatedHost = useRef<HTMLDivElement>(null);
  const slots = useRef<
    Partial<Record<NativePane, { adapter: ReaderAdapter; toc: TOCItem[] }>>
  >({});
  const scroll = useRef<LinkedScroll | undefined>(undefined);
  const restoreSwap = useRef<(() => void) | undefined>(undefined);
  const sourceAnnotations = useMemo(
    () => annotations.filter(onSource),
    [annotations],
  );
  useLayoutEffect(() => {
    restoreSwap.current?.();
    restoreSwap.current = undefined;
  }, [split.swapped]);
  useLayoutEffect(
    () => () => {
      scroll.current?.destroy();
      scroll.current = undefined;
      slots.current = {};
    },
    [],
  );
  const ready = (side: NativePane, adapter: ReaderAdapter, toc: TOCItem[]) => {
    slots.current[side] = { adapter, toc };
    const { source, translation } = slots.current;
    if (scroll.current || !source || !translation) return;
    if (
      source.adapter.getPageCount?.() !== translation.adapter.getPageCount?.()
    )
      throw new Error("对照文件页数与原文不一致，请重新生成");
    const linked = linkNativePDFPanes(
      sourceHost.current!.querySelector<HTMLElement>(".pdf-container")!,
      translatedHost.current!.querySelector<HTMLElement>(".pdf-container")!,
      (previous) => {
        const reader = slots.current[previous]?.adapter;
        reader?.cancelBlockFocus?.();
        reader?.clearSelection();
      },
    );
    scroll.current = linked;
    onReady(
      pairedReader(source.adapter, translation.adapter, linked),
      source.toc,
    );
  };
  const paneEvents = (side: NativePane): ReaderEvents => ({
    ...events,
    location: (location, progress) => {
      if (scroll.current?.active === side) events.location(location, progress);
    },
    selection: (value) => {
      if (value || scroll.current?.active === side) events.selection(value);
    },
    annotation: (value) => {
      if (value || scroll.current?.active === side) events.annotation?.(value);
    },
  });
  return (
    <TranslationPanes
      mode="parallel"
      deferResize
      split={{
        ...split,
        onSwap() {
          restoreSwap.current = scroll.current?.captureForSwap();
          split.onSwap();
        },
      }}
      sourceLabel="原文"
      translationLabel="译文"
      source={
        <div className="translation-source" ref={sourceHost}>
          <InterleafView
            {...props}
            annotations={sourceAnnotations}
            events={paneEvents("source")}
            onReady={(adapter, toc) => ready("source", adapter, toc)}
          />
        </div>
      }
      translation={
        <div className="translation-source" ref={translatedHost}>
          <InterleafView
            {...props}
            nativeReading={nativeReading}
            annotations={annotations}
            events={paneEvents("translation")}
            onReady={(adapter, toc) => ready("translation", adapter, toc)}
          />
        </div>
      }
    />
  );
}
