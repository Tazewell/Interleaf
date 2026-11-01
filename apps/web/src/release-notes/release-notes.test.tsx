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
