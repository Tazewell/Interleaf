import { expect, it } from "vitest";
import type { PDFBlock, TOCItem } from "@interleaf/core";
import { activeHeading, headingOutline, pageOutline } from "./pdf-outline";

const heading = (id: string, page: number, text: string, y = 0.1): PDFBlock => ({
  id,
  page,
  label: "paragraph_title",
  text,
  bounds: { x: 0.08, y, width: 0.84, height: 0.02 },
});
const serl = [
  heading("b1", 1, "Abstract", 0.2),
  heading("b2", 1, "1  Introduction", 0.4),
  heading("b3", 2, "2  Related Work"),
  {
    id: "body",
    page: 2,
    label: "text",
    text: "3  Method",
    bounds: { x: 0.08, y: 0.3, width: 0.84, height: 0.2 },
  },
  heading("b4", 3, "3  Method"),
  heading("b5", 3, "3.1  Generation", 0.3),
  heading("b6", 4, "4  Experiments"),
  heading("b7", 4, "4.1  Setup", 0.3),
  heading("b8", 5, "Baselines", 0.2),
  heading("b9", 5, "4.2  Main Results", 0.6),
  heading("b10", 6, "PVLDB Reference Format:"),
  heading("b11", 7, "A  Appendix"),
  heading("b12", 7, "A.1  Proofs", 0.4),
];
const labels = (items: TOCItem[]): unknown[] =>
  items.map((item) => [item.label, labels(item.children)]);

it("builds the chapter hierarchy from parsed headings", () => {
  const outline = headingOutline(serl);
  expect(labels(outline)).toEqual([
    ["Abstract", []],
    ["1 Introduction", []],
    ["2 Related Work", []],
    ["3 Method", [["3.1 Generation", []]]],
    [
      "4 Experiments",
      [["4.1 Setup", []], ["Baselines", []], ["4.2 Main Results", []]],
    ],
    ["A Appendix", [["A.1 Proofs", []]]],
  ]);
  expect(outline[3]!.children[0]).toMatchObject({
    id: "heading-b5",
    location: { type: "pdf", page: 3, x: 0.08, y: 0.3 },
  });
});

it("ignores non-heading blocks, trailing labels and repeated titles", () => {
  const blocks = [
    heading("a", 1, "1  Introduction"),
    heading("b", 1, "1   Introduction"),
    heading("c", 2, "PVLDB Reference Format:"),
  ];
  expect(headingOutline(blocks).map((item) => item.label)).toEqual([
    "1 Introduction",
  ]);
  expect(headingOutline([])).toEqual([]);
});

it("detects the one-entry-per-page fallback", () => {
  const page = (id: string, page: number): TOCItem => ({
    id,
    label: `第 ${page} 页`,
    location: { type: "pdf", page },
    children: [],
  });
  expect(pageOutline([])).toBe(true);
  expect(pageOutline([page("page-1", 1), page("page-2", 2)])).toBe(true);
  expect(pageOutline([page("heading-b1", 1)])).toBe(false);
});

it("highlights one heading per page, falling back to the previous one", () => {
  const outline = headingOutline(serl);
  expect(activeHeading(outline, 1)?.label).toBe("Abstract");
  expect(activeHeading(outline, 2)?.label).toBe("2 Related Work");
  expect(activeHeading(outline, 3)?.label).toBe("3 Method");
  expect(activeHeading(outline, 5)?.label).toBe("Baselines");
  // Page 6 only has a colon-ended metadata label, so the last real heading wins.
  expect(activeHeading(outline, 6)?.label).toBe("4.2 Main Results");
  expect(activeHeading(outline, 8)?.label).toBe("A.1 Proofs");
  expect(activeHeading(outline, 0)).toBeUndefined();
});
