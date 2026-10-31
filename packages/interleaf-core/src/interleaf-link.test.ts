import { expect, it } from "vitest";
import { parseInterleafLink, interleafLink } from "./interleaf-link";

const id = "0123456789abcdef0123456789abcdef";
it("round-trips document, annotation and page targets", () => {
  for (const target of [
    { id },
    { id, annotation: "fedcba9876543210fedcba9876543210" },
    { id, page: 12 },
  ])
    expect(parseInterleafLink(interleafLink(target))).toEqual(target);
});
it("rejects other schemes, actions and malformed parameters", () => {
  for (const link of [
    `https://open?id=${id}`,
    `interleaf://delete?id=${id}`,
    "interleaf://open?id=../../etc",
    "not a link",
  ])
    expect(parseInterleafLink(link)).toBeNull();
  expect(
    parseInterleafLink(`interleaf://open?id=${id}&annotation=x&page=-1&extra=1`),
  ).toEqual({ id });
});
