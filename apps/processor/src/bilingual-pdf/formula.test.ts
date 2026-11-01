import { expect, it } from "vitest";
import { protectFormulas, validateFormulaTokens } from "./formula";

const bounds = { x: 0, y: 0, width: 10, height: 12 };
const formulas = [{ token: "{v0}", bounds }];

it.each([
  "{}",
  "{name}",
  "{value}",
  '{"a":{"b":1}}',
  "open {",
  "close }",
  "{version}",
  "{Vname}",
  "{v０}",
])("retains literal braces %s alongside protected formulas", (literal) => {
  const span = { text: literal, bounds, fontSize: 12, math: false };
  expect(protectFormulas([span]).source).toBe(literal);
  expect(() => validateFormulaTokens(literal, [])).not.toThrow();
  expect(() =>
    validateFormulaTokens(literal + " {v0}", formulas),
  ).not.toThrow();
});

it.each([
  "",
  "{v0}{v0}",
  "{v1}",
  "{v00}",
  "{V0}",
  "{v0",
  "{v0x}",
  "{v0 }",
  "{v0{",
  "{v0}{V2}",
  "{v0}{v2",
])("rejects missing, repeated or damaged indexed markers %s", (text) =>
  expect(() => validateFormulaTokens(text, formulas)).toThrow(/公式占位/),
);

it.each(["{v0}", "{V2}", "{v00}", "{v3", "{V4x}"])(
  "rejects unprotected source marker collisions %s before API use",
  (text) => {
    // PDF extraction can split an otherwise adjacent literal across text spans.
    const spans = [...text].map((text, x) => ({
      text,
      bounds: { ...bounds, x: x * 10 },
      fontSize: 12,
      math: false,
    }));
    expect(() => protectFormulas(spans)).toThrow(/原文.*公式协议/);
  },
);

it("protects set braces inside a formula and requires sequential canonical metadata", () => {
  const protectedText = protectFormulas([
    { text: "{v0}", bounds, fontSize: 12, math: true },
  ]);
  expect(protectedText.source).toBe("{v0}");
  expect(protectedText.originalSource).toBe("{v0}");
  expect(() =>
    validateFormulaTokens("{v0}", protectedText.formulas),
  ).not.toThrow();
  expect(() =>
    validateFormulaTokens("{v1}", [{ token: "{v1}", bounds }]),
  ).toThrow();
  expect(() =>
    validateFormulaTokens("{v0}", [...formulas, ...formulas]),
  ).toThrow();
});
