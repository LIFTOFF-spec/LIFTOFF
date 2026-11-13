import { describe, expect, it } from "vitest";
import { hammingDistance, isPerceptualHash, PHASH_SIZE, perceptualHash } from "./image-hash";

/** Gambar sintetis: fungsi (x, y) dalam [0,1] → nilai abu-abu 0–255. */
function render(fn: (x: number, y: number) => number): number[] {
  const px: number[] = [];
  for (let y = 0; y < PHASH_SIZE; y++) {
    for (let x = 0; x < PHASH_SIZE; x++) {
      px.push(Math.max(0, Math.min(255, fn(x / PHASH_SIZE, y / PHASH_SIZE))));
    }
  }
  return px;
}

const circle = (x: number, y: number) => ((x - 0.5) ** 2 + (y - 0.45) ** 2 < 0.09 ? 220 : 40);
const stripes = (x: number) => (Math.floor(x * 6) % 2 === 0 ? 230 : 20);

describe("perceptualHash", () => {
  it("menghasilkan 16 karakter hex dan deterministik", () => {
    const h = perceptualHash(render(circle));
    expect(isPerceptualHash(h)).toBe(true);
    expect(perceptualHash(render(circle))).toBe(h);
  });

  it("tahan perubahan brightness/kontras ringan", () => {
    const a = perceptualHash(render(circle));
    const b = perceptualHash(render((x, y) => circle(x, y) * 0.8 + 30));
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(4);
  });

  it("gambar berbeda berjarak jauh", () => {
    const a = perceptualHash(render(circle));
    const b = perceptualHash(render((x) => stripes(x)));
    expect(hammingDistance(a, b)).toBeGreaterThan(20);
  });

  it("menolak ukuran input yang salah", () => {
    expect(() => perceptualHash([1, 2, 3])).toThrow();
  });
});

describe("hammingDistance", () => {
  it.each([
    ["0000000000000000", "0000000000000000", 0],
    ["0000000000000000", "0000000000000001", 1],
    ["ffffffffffffffff", "0000000000000000", 64],
    ["f0f0f0f0f0f0f0f0", "0f0f0f0f0f0f0f0f", 64],
    ["8000000000000001", "0000000000000000", 2],
  ])("%s vs %s = %i", (a, b, d) => {
    expect(hammingDistance(a, b)).toBe(d);
  });
});
