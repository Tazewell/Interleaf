import { afterEach, expect, it, vi } from "vitest";
import { api, configureAPI } from "./index";
afterEach(() => vi.unstubAllGlobals());
it("uses authenticated native reading transport, escaped identities and cancellation", async () => {
  configureAPI("reading/token");
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({ status: "ready" }),
  );
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  await api.createNativePDFReading("doc/one", controller.signal);
  await api.nativePDFReading("doc/one", "job?one", controller.signal);
  await api.nativePDFReadingMetadata("doc/one", "key/one", controller.signal);
  await api.cancelNativePDFReading("doc/one", "job?one");
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/documents/doc%2Fone/native-pdf-reading",
    "/api/documents/doc%2Fone/native-pdf-reading/job%3Fone",
    "/api/documents/doc%2Fone/native-pdf-reading/cache/key%2Fone/metadata",
    "/api/documents/doc%2Fone/native-pdf-reading/job%3Fone",
  ]);
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: "POST",
    body: "{}",
    signal: controller.signal,
    headers: { Authorization: "Bearer reading/token" },
  });
  expect(fetcher.mock.calls[3][1]).toMatchObject({ method: "DELETE" });
  expect(api.nativePDFReadingFileURL("doc/one", "key/one")).toBe(
    "/pub/reading%2Ftoken/doc%2Fone/native-pdf-reading/key%2Fone/file",
  );
});

it("sends explicit translation-only layout while preserving legacy default payload", async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ status: "ready" }),
  );
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  await api.createNativePDFReading("doc", signal, "translation-only");
  await api.createNativePDFReading("doc", undefined, "side-by-side");
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    body: JSON.stringify({ layout: "translation-only" }),
    signal,
  });
  expect(fetcher.mock.calls[1][1]).toMatchObject({ body: "{}" });
});

it("sends BabelDOC only when the engine is explicitly selected", async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ status: "ready" }),
  );
  vi.stubGlobal("fetch", fetcher);
  await api.createNativePDFReading(
    "doc",
    undefined,
    "translation-only",
    "babeldoc",
  );
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    body: JSON.stringify({ layout: "translation-only", engine: "babeldoc" }),
  });
});
