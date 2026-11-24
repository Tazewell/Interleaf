// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateOffer } from "@interleaf/core";
import { UpdateOfferHost } from "./UpdateOfferHost";

const offer: UpdateOffer = {
  id: 2,
  currentVersion: "0.8.16",
  version: "0.8.17",
  actionLabel: "下载并安装",
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let emit: (value: UpdateOffer) => void;
const respond = vi.fn(async (_id: number, _accept: boolean) => {});
const unsubscribe = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.interleafDesktop = {
    platform: "win32",
    onUpdateOffer: (listener: typeof emit) => {
      emit = listener;
      return unsubscribe;
    },
    respondToUpdateOffer: respond,
  } as unknown as typeof window.interleafDesktop;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  emit = () => {};
  await act(async () => root.render(<UpdateOfferHost />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.interleafDesktop;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const dialog = () => document.querySelector('[role="dialog"]');
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );

it("shows both versions and responds once only after explicit download consent", async () => {
  expect(dialog()).toBeNull();
  await act(async () => emit(offer));
  expect(dialog()?.textContent).toEqual(expect.stringContaining("0.8.16"));
  expect(dialog()?.textContent).toEqual(expect.stringContaining("0.8.17"));
  expect(respond).not.toHaveBeenCalled();
  const download = button("下载并安装");
  expect(download).toBeDefined();
  await act(async () => {
    download!.click();
    download!.click();
  });
  expect(respond).toHaveBeenCalledExactlyOnceWith(2, true);
  expect(dialog()).toBeNull();
});

it("declines using Later and handles a subsequent offer on the same subscription", async () => {
  await act(async () => emit(offer));
  const later = button("稍后");
  expect(later).toBeDefined();
  await act(async () => later!.click());
  expect(respond).toHaveBeenCalledExactlyOnceWith(2, false);
  await act(async () => emit({ ...offer, id: 3, version: "0.8.18" }));
  expect(dialog()?.textContent).toEqual(expect.stringContaining("0.8.18"));
});

it("declines with Escape while the dialog is focused", async () => {
  await act(async () => emit(offer));
  const later = button("稍后");
  expect(later).toBeDefined();
  await act(async () => {
    later!.focus();
    later!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(respond).toHaveBeenCalledExactlyOnceWith(2, false);
});

it("keeps the offer available to retry if submitting the choice fails", async () => {
  respond.mockRejectedValueOnce(new Error("IPC failed"));
  await act(async () => emit(offer));
  await act(async () => button("下载并安装")!.click());
  expect(dialog()).not.toBeNull();
  expect(button("下载并安装")?.disabled).toBe(false);
  await act(async () => button("下载并安装")!.click());
  expect(respond.mock.calls).toEqual([
    [2, true],
    [2, true],
  ]);
  expect(dialog()).toBeNull();
});
