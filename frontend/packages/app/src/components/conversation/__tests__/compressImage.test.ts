import { describe, expect, it } from "vitest";
import { compressedName, fitSize, isCompressible } from "../compressImage";

describe("compressImage decisions", () => {
  it("scales the long side to 1600 and never upscales", () => {
    expect(fitSize(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(fitSize(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
  it("skips GIFs and non-images", () => {
    expect(isCompressible("image/heic")).toBe(true);
    expect(isCompressible("image/gif")).toBe(false);
    expect(isCompressible("application/pdf")).toBe(false);
  });
  it("renames to the output type", () => {
    expect(compressedName("IMG_1.HEIC", "image/jpeg")).toBe("IMG_1.jpg");
    expect(compressedName("a.b.png", "image/png")).toBe("a.b.png");
  });
});
