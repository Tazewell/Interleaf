// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@interleaf/api";
import { ReleaseNotesHost } from "./ReleaseNotesHost";

vi.mock("@interleaf/api", () => ({
  api: {
    releasePreferences: vi.fn(),
    saveReleasePreferences: vi.fn(async (value) => value),
  },
}));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("starts an empty new library without a guide or release popup", async () => {
  vi.mocked(api.releasePreferences).mockResolvedValue({});
  await act(async () =>
    root.render(
      <ReleaseNotesHost ready version="0.8.7" hasDocuments={false} />,
    ),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(api.saveReleasePreferences).toHaveBeenCalledWith({
    seenVersion: "0.8.7",
  });
});
it("keeps update notes for an existing library without old demo links", async () => {
  vi.mocked(api.releasePreferences).mockResolvedValue({ seenVersion: "0.8.6" });
  await act(async () =>
    root.render(<ReleaseNotesHost ready version="0.8.7" hasDocuments />),
  );
  expect(document.body.textContent).toContain("0.8.7 更新内容");
  expect(document.body.textContent).not.toContain("查看演示");
  expect(document.body.textContent).not.toContain("指南");
  const close = document.querySelector<HTMLButtonElement>(
    '[aria-label="关闭更新说明"]',
  );
  expect(close).not.toBeNull();
  await act(async () => close!.click());
  expect(api.saveReleasePreferences).toHaveBeenCalledWith({
    seenVersion: "0.8.7",
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("does not repeat an acknowledged version", async () => {
  vi.mocked(api.releasePreferences).mockResolvedValue({ seenVersion: "0.8.7" });
  await act(async () =>
    root.render(<ReleaseNotesHost ready version="0.8.7" hasDocuments />),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(api.saveReleasePreferences).not.toHaveBeenCalled();
});

it.each([
  { seenVersion: "0.8.11", newItems: 6, earlierItems: 72 },
  { seenVersion: "0.8.10", newItems: 10, earlierItems: 68 },
  { seenVersion: undefined, newItems: 6, earlierItems: 72 },
])(
  "shows unread notes before the collapsed history ($seenVersion)",
  async ({ seenVersion, newItems, earlierItems }) => {
    vi.mocked(api.releasePreferences).mockResolvedValue({ seenVersion });
    await act(async () =>
      root.render(<ReleaseNotesHost ready version="0.8.12" hasDocuments />),
    );

    const dialog = document.querySelector('[role="dialog"]')!;
    const title = dialog.querySelector('[data-slot="dialog-title"]')!;
    const notes = dialog.querySelector(
      '[role="region"][aria-label="更新条目"]',
    )!;
    const history = notes.querySelector("details")!;
    expect(title.textContent).toContain("0.8.12 更新内容");
    await vi.waitFor(() => expect(document.activeElement).toBe(title));
    expect(notes.contains(title)).toBe(false);
    expect(notes.querySelector('[aria-label="关闭更新说明"]')).toBeNull();
    expect(notes.querySelectorAll(":scope > ul > li")).toHaveLength(newItems);
    expect(notes.querySelector(":scope > ul")?.textContent).toContain(
      "PDF 原版式对照与单栏译文",
    );
    expect(history.open).toBe(false);
    expect(history.querySelectorAll("li")).toHaveLength(earlierItems);
    await act(async () => history.querySelector("summary")!.click());
    expect(history.open).toBe(true);
  },
);
