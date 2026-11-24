import { act } from "react";
import { expect } from "vitest";

export async function choosePDFFormat(
  host: HTMLElement,
  label: "原版式" | "流式",
) {
  const trigger = host.querySelector<HTMLButtonElement>(
    '[aria-label="排版方式"]',
  );
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((node) => node.textContent === label);
  expect(option).toBeDefined();
  await act(async () => {
    option!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    option!.click();
  });
}

export async function clickPDFContent(
  host: HTMLElement,
  label: "原文" | "对照" | "译文",
) {
  const tab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (node) => node.textContent === label,
  );
  expect(tab).toBeDefined();
  await act(async () => tab!.click());
}
