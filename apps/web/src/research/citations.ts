import { createContext } from "react";
import type { Root, PhrasingContent, Link } from "mdast";
import { SKIP, visit } from "unist-util-visit";
export const ResearchCitationNavigation = createContext<
  { sourceIds: string[]; navigate: (id: string) => void } | undefined
>(undefined);
export function remarkResearchCitations({
  sourceIds = [],
}: { sourceIds?: string[] } = {}) {
  const known = new Set(sourceIds);
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (node.type === "link" || node.type === "linkReference") return SKIP;
      if (node.type !== "text" || index === undefined || !parent) return;
      const parts: PhrasingContent[] = [];
      let start = 0;
      for (const match of node.value.matchAll(/\[([a-f0-9]{32})\]/g)) {
        parts.push({
          type: "text",
          value: node.value.slice(start, match.index),
        });
        const id = match[1];
        parts.push(
          known.has(id)
            ? ({
                type: "link",
                url: `#reader-research?source=${id}`,
                children: [
                  { type: "text", value: `[${sourceIds.indexOf(id) + 1}]` },
                ],
              } satisfies Link)
            : { type: "text", value: match[0] },
        );
        start = match.index! + match[0].length;
      }
      if (!start) return;
      parts.push({ type: "text", value: node.value.slice(start) });
      (parent.children as PhrasingContent[]).splice(index, 1, ...parts);
      return [SKIP, index + parts.length];
    });
  };
}
