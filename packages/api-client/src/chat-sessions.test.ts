import { afterEach, expect, it, vi } from "vitest";
import { api, configureAPI } from "./index";

afterEach(() => vi.unstubAllGlobals());

it("deletes only the addressed session and returns annotation reconciliation metadata", async () => {
  configureAPI("test-token");
  let request: { url: string; init?: RequestInit } | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      request = { url, init };
      return Response.json({ ok: true, unlinkedAnnotationIds: ["question-a"] });
    }),
  );
  const result = await api.deleteChatSession("document/one", "session?two");
  expect(request?.url).toBe(
    "/api/documents/document%2Fone/chat-sessions/session%3Ftwo",
  );
  expect(request?.init?.method).toBe("DELETE");
  expect(request?.init?.body).toBeUndefined();
  expect(result).toEqual({ ok: true, unlinkedAnnotationIds: ["question-a"] });
});
