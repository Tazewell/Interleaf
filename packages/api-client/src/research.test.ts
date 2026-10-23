import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { ResearchRunInput } from "@reader/core";
import type { components } from "./schema";
import { researchAPI } from "./research";
import { configureAPI, RequestError } from "./transport";

afterEach(() => vi.unstubAllGlobals());

it("keeps omitted ideaCount compatible with generated create input", () => {
  const input = {
    userMessageId: "a".repeat(32),
    question: "Compare",
    mode: "compare",
    network: "deny",
    budget: {
      maxModelRequests: 200,
      maxSearchRequests: 24,
      maxRemoteReads: 8,
      maxMinutes: 30,
    },
  } satisfies ResearchRunInput;
  expectTypeOf(input).toExtend<components["schemas"]["ResearchRunInput"]>();
});

it("authenticates raw events and Markdown while forwarding abort and cursor", async () => {
  configureAPI("research-token");
  const signal = new AbortController().signal;
  const fetch = vi.fn(async () => new Response("report text"));
  vi.stubGlobal("fetch", fetch);
  const stream = await researchAPI.events("run/id", 17, signal);
  expect(await stream.text()).toBe("report text");
  expect(fetch).toHaveBeenCalledWith(
    "/api/research/runs/run%2Fid/events?after=17",
    expect.objectContaining({
      signal,
      headers: expect.objectContaining({
        Authorization: "Bearer research-token",
      }),
    }),
  );
  expect(await researchAPI.markdown("report/id", signal)).toBe("report text");
});

it("preserves request identity and rejects failed raw responses", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ error: "scope changed", code: "conflict" }),
        { status: 409 },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const input = { requestId: "b".repeat(32) };
  await expect(
    researchAPI.controlRun("run", "resume", input),
  ).rejects.toBeInstanceOf(RequestError);
  expect(fetch).toHaveBeenCalledWith(
    "/api/research/runs/run/resume",
    expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
  );
  await expect(researchAPI.events("run")).rejects.toThrow("scope changed");
});
