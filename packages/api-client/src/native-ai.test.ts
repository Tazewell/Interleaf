import { afterEach, expect, it, vi } from "vitest";
import { api } from "./index";

afterEach(() => vi.unstubAllGlobals());

it("requests a fresh catalog only when explicitly forced and preserves cancellation", async () => {
  const requests: [string, RequestInit | undefined][] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push([url, init]);
    return new Response("[]", { status: 200 });
  });
  const controller = new AbortController();
  await api.agentModels("chat", controller.signal);
  await api.agentModels("translation", controller.signal, true);
  expect(requests.map(([url]) => url)).toEqual([
    "/api/ai/models?role=chat",
    "/api/ai/models?role=translation&refresh=1",
  ]);
  expect(requests[1]![1]?.signal).toBe(controller.signal);
});
