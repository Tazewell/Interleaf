import { expect, it } from "vitest";
import * as rendering from "./render-page";

it("keeps actual padded crop pixels, including clipped page edges", () => {
  const crop = (
    rendering as unknown as {
      blockCropBounds?: (
        bounds: { x: number; y: number; width: number; height: number },
        width: number,
        height: number,
      ) => unknown;
    }
  ).blockCropBounds;
  expect(crop).toBeTypeOf("function");
  expect(
    crop!({ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }, 1200, 1600),
  ).toEqual({ x: 117, y: 317, width: 366, height: 166 });
  expect(crop!({ x: 0.9, y: 0.9, width: 0.1, height: 0.1 }, 800, 600)).toEqual({
    x: 717,
    y: 537,
    width: 83,
    height: 63,
  });
  expect(crop!({ x: 0, y: 0, width: 0.1, height: 0.1 }, 800, 600)).toEqual({
    x: 0,
    y: 0,
    width: 86,
    height: 66,
  });
});
