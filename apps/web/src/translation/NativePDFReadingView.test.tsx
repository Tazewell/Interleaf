// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  defaultTheme,
  type Document,
  type NativePDFReadingManifest,
  type ReaderAdapter,
} from "@interleaf/core";
const fixture = vi.hoisted(() => ({
  state: {
    busy: true,
    cancelling: false,
    error: "",
    job: undefined as unknown,
    retry: vi.fn(),
    cancel: vi.fn(),
  },
  props: undefined as Record<string, unknown> | undefined,
  goTo: vi.fn(async () => {}),
}));
vi.mock("./useNativePDFReading", () => ({
  useNativePDFReading: () => fixture.state,
}));
vi.mock("@interleaf/api", () => ({
  api: {
    nativePDFReadingFileURL: (id: string, key: string) =>
      `/cached/${id}/${key}`,
  },
}));
vi.mock("../InterleafView", () => ({
  InterleafView: (props: Record<string, unknown>) => {
    fixture.props = props;
    useEffect(() => {
      (props.onReady as (adapter: ReaderAdapter, toc: []) => void)(
        { goTo: fixture.goTo } as unknown as ReaderAdapter,
        [],
      );
    }, []);
    return <div>单份双语 PDF</div>;
  },
}));
import { NativePDFReadingView } from "./NativePDFReadingView";
let root: Root, host: HTMLDivElement;
const onFlow = vi.fn(),
  onReady = vi.fn();
const metadata = {
  version: 1,
  documentId: "doc",
  cacheKey: "key",
  pages: [],
  translatedParagraphs: 3,
  originalParagraphs: 2,
  warnings: [],
} as unknown as NativePDFReadingManifest;
async function render() {
  await act(async () =>
    root.render(
      <NativePDFReadingView
        document={{ id: "doc", type: "pdf" } as Document}
        theme={defaultTheme}
        blocks={[]}
        translations={[]}
        annotations={[]}
        initialLocation={{ type: "pdf", page: 3 }}
        onReady={onReady}
        events={{ location: vi.fn(), selection: vi.fn() }}
        onUseFlow={onFlow}
        pageNavigation={<button>原文页码导航</button>}
      />,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  fixture.state = {
    busy: true,
    cancelling: false,
    error: "",
    job: undefined,
    retry: vi.fn(),
    cancel: vi.fn(),
  };
  fixture.props = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("shows generation state without mounting another reader", async () => {
  await render();
  expect(host.textContent).toContain("正在生成原版式对照");
  expect(fixture.props).toBeUndefined();
});
it("loads the original document identity with cached geometry and restores its page", async () => {
  fixture.state = {
    ...fixture.state,
    busy: false,
    job: { status: "ready", metadata },
  };
  await render();
  expect(host.textContent).toContain("单份双语 PDF");
  expect(host.textContent).toContain("2 段保留原文");
  expect(fixture.props?.document).toMatchObject({ id: "doc" });
  expect(fixture.props?.nativeReading).toMatchObject({
    metadata,
    fileURL: "/cached/doc/key",
  });
  expect(fixture.goTo).toHaveBeenCalledWith({ type: "pdf", page: 3 });
  expect(onReady).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("原文页码导航");
});
it("offers retry and a working flow fallback after failure", async () => {
  fixture.state = { ...fixture.state, busy: false, error: "版面尚未解析完成" };
  await render();
  expect(host.textContent).toContain("版面尚未解析完成");
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "重试")!
      .click(),
  );
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "使用流式对照")!
      .click(),
  );
  expect(fixture.state.retry).toHaveBeenCalledOnce();
  expect(onFlow).toHaveBeenCalledOnce();
});
