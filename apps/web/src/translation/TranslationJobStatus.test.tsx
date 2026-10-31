// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Processing } from "@interleaf/core";
import { TranslationJobStatus } from "./TranslationJobStatus";

it.each([
  { enabled: false, status: "failed" },
  { enabled: true, status: "paused" },
])("hides failed-job retry when paused: %j", async ({ enabled, status }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <TranslationJobStatus
          processing={
            {
              enabled,
              status,
              translating: { status: "failed", detail: "之前的失败" },
            } as Processing
          }
          retry={vi.fn()}
        />,
      ),
    );
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).not.toContain("之前的失败");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
