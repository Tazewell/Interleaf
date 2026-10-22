// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AISettings } from "./AISettings";
import { useReaderStore } from "../store";
import type { NativeAIConfig } from "@reader/core";

let root: Root;
let host: HTMLDivElement;
let config: NativeAIConfig;
let writes: Record<string, any>[];
let probes: number;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  config = {
    version: 2,
    connection: {
      protocol: "openai",
      url: "http://localhost:11434/v1",
      hasKey: true,
    },
    models: { chat: "manual-chat", translation: "manual-fast" },
    efforts: { chat: "high" },
    apiModels: [],
  };
  writes = [];
  probes = 0;
  useReaderStore.setState({ aiConfig: config, aiModelSaving: false });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/ai/models"))
        return new Response(JSON.stringify({ error: "模型列表暂不可用" }), {
          status: 502,
        });
      if (url.includes("/api/ai/check")) {
        probes++;
        return new Response(
          JSON.stringify({
            text: true,
            vision: false,
            checkedAt: "2026-10-22",
            model: "manual-chat",
            fingerprint: "test",
          }),
        );
      }
      if (url.endsWith("/api/ai/config")) {
        if (init?.method === "PUT") {
          const update = JSON.parse(String(init.body));
          writes.push(update);
          config = {
            ...config,
            ...update,
            connection: {
              ...config.connection,
              ...update.connection,
              hasKey: update.connection.key === null ? false : true,
            },
          };
          delete (config.connection as any).key;
        }
        return new Response(JSON.stringify(config));
      }
      throw new Error(`unexpected request ${url}`);
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function change(label: string, value: string) {
  const field = host.querySelector(
    `[aria-label="${label}"]`,
  ) as HTMLInputElement;
  expect(field).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(text: string) {
  const button = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}

it("configures one connection and role models without external Agent controls", async () => {
  await act(async () => root.render(<AISettings open />));
  expect(host.textContent).not.toMatch(/SDK|登录|安装|Codex|Claude Code|Kimi/);
  expect(host.querySelectorAll('[aria-label="API 地址"]')).toHaveLength(1);
  expect(
    (host.querySelector('[aria-label="问答模型"]') as HTMLInputElement).value,
  ).toBe("manual-chat");
  expect(
    (host.querySelector('[aria-label="研究模型"]') as HTMLInputElement)
      .placeholder,
  ).toBe("继承问答模型");
  expect(host.textContent).toContain("模型列表暂不可用");
  expect(probes).toBe(0);
  await change("翻译模型", "custom-fast");
  await click("保存模型");
  expect(config.models.translation).toBe("custom-fast");
  expect(config.models.chat).toBe("manual-chat");
  expect(config.models.research ?? "").toBe("");
  expect(config.connection.hasKey).toBe(true);
  expect(writes.at(-1)!.connection).not.toHaveProperty("key");
  expect(writes.at(-1)!.connection).not.toHaveProperty("hasKey");
  await change("API 地址", "http://localhost:1234/v1");
  await change("API Key", "synthetic-new-key");
  await click("保存连接");
  expect(config.connection.url).toBe("http://localhost:1234/v1");
  expect(writes.at(-1)!.connection.key).toBe("synthetic-new-key");
  expect(
    (host.querySelector('[aria-label="API Key"]') as HTMLInputElement).value,
  ).toBe("");
  expect(probes).toBe(0);
});

it("requires connection confirmation before editing migrated role models or prompts", async () => {
  config = { ...config, needsConfiguration: "请确认主要 API 连接" };
  useReaderStore.setState({ aiConfig: config });
  await act(async () => root.render(<AISettings open />));
  expect(
    (host.querySelector('[aria-label="翻译模型"]') as HTMLInputElement)
      .disabled,
  ).toBe(true);
  expect((host.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(
    true,
  );
  expect(
    Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "保存连接",
    )!.disabled,
  ).toBe(false);
  expect(writes).toHaveLength(0);
  expect(probes).toBe(0);
});
