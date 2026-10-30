import type { PDFBlock, TOCItem } from "@reader/core";

// Numbered starts: "3", "3.1" and appendix letters like "A.1". A lone capital
// letter is left alone so ordinary titles stay top-level.
const SECTION_NUMBER =
  /^\s*(?:(\d+(?:\.\d+)*)|([A-Z](?:\.\d+)+))(?:[.、:：]\s*|\s+)/;

function normalize(text: string) {
  return text.trim().replace(/\s+/g, " ");
}

function sectionNumber(text: string) {
  const match = SECTION_NUMBER.exec(text);
  if (!match) return undefined;
  const parts = (match[1] ?? match[2]).split(".");
  return { level: parts.length, top: parts[0] ?? "" };
}

/**
 * A document outline built from parsed headings, for PDFs that carry no
 * embedded outline. Blocks arrive in reading order, including two-column pages.
 */
export function headingOutline(blocks: PDFBlock[]): TOCItem[] {
  const headings = blocks
    .map((block) => ({ block, text: normalize(block.text) }))
    .filter(
      ({ block, text }) =>
        block.label === "paragraph_title" &&
        text.length > 0 &&
        text.length <= 160 &&
        /\p{L}/u.test(text) &&
        // "PVLDB Reference Format:"-style fields are labels, not sections.
        !/[:：]$/.test(text),
    );
  const entries: Array<{ level: number; item: TOCItem }> = [];
  let chapter: string | undefined;
  let previous = "";
  headings.forEach(({ block, text }, index) => {
    const key = text.toLocaleLowerCase();
    if (key === previous) return;
    previous = key;
    const number = sectionNumber(text);
    let level = 1;
    if (number) {
      level = number.level;
      if (level === 1) chapter = number.top;
    } else {
      const next = sectionNumber(headings[index + 1]?.text ?? "");
      // An unnumbered title between numbered siblings ("Baselines" before
      // "4.2") is a subsection, not a new chapter.
      if (next && next.level > 1 && next.top === chapter) level = 2;
      else chapter = undefined;
    }
    entries.push({
      level,
      item: {
        id: `heading-${block.id}`,
        label: text,
        location: {
          type: "pdf",
          page: block.page,
          x: block.bounds.x,
          y: block.bounds.y,
        },
        children: [],
      },
    });
  });
  const outline: TOCItem[] = [];
  const stack: Array<{ level: number; item: TOCItem }> = [];
  for (const entry of entries) {
    while (stack.length && stack[stack.length - 1]!.level >= entry.level)
      stack.pop();
    const parent = stack[stack.length - 1]?.item;
    if (parent) parent.children.push(entry.item);
    else outline.push(entry.item);
    stack.push(entry);
  }
  return outline;
}

/** Whether the engine only produced its one-entry-per-page fallback. */
export function pageOutline(toc: TOCItem[]): boolean {
  return !toc.length || toc.every((item) => item.id.startsWith("page-"));
}

/** The single heading a page belongs to, so sibling rows do not all light up. */
export function activeHeading(toc: TOCItem[], page: number) {
  let first: TOCItem | undefined;
  let latest: TOCItem | undefined;
  const visit = (items: TOCItem[]) => {
    for (const item of items) {
      if (item.location.type === "pdf") {
        if (item.location.page === page) first ??= item;
        else if (item.location.page < page) latest = item;
      }
      visit(item.children);
    }
  };
  visit(toc);
  return first ?? latest;
}
