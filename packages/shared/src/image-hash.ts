/**
 * Perceptual hash gambar (pHash, 64 bit) untuk deteksi gambar salinan (P4).
 *
 * Fungsi murni: input berupa piksel grayscale PHASH_SIZE × PHASH_SIZE (0–255) yang sudah
 * di-resize oleh pemanggil (API memakai sharp). pHash memakai DCT frekuensi rendah sehingga
 * tahan resize, recolor ringan, kompresi, dan crop kecil. Kedekatan diukur dengan jarak Hamming.
 */

export const PHASH_SIZE = 32;
const LOW = 8;

const COS_TABLE: number[][] = Array.from({ length: LOW }, (_, u) =>
  Array.from({ length: PHASH_SIZE }, (_, x) =>
    Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PHASH_SIZE)),
  ),
);

/** Menghasilkan pHash 64-bit sebagai string hex 16 karakter. */
export function perceptualHash(gray: ArrayLike<number>): string {
  if (gray.length !== PHASH_SIZE * PHASH_SIZE) {
    throw new Error(`perceptualHash: butuh ${PHASH_SIZE}x${PHASH_SIZE} piksel grayscale`);
  }
  // DCT 2D terpisah, hanya koefisien frekuensi rendah 8×8 yang dihitung.
  const rows: number[][] = [];
  for (let y = 0; y < PHASH_SIZE; y++) {
    const row: number[] = [];
    for (let u = 0; u < LOW; u++) {
      let sum = 0;
      const cos = COS_TABLE[u]!;
      for (let x = 0; x < PHASH_SIZE; x++) sum += gray[y * PHASH_SIZE + x]! * cos[x]!;
      row.push(sum);
    }
    rows.push(row);
  }
  const coeffs: number[] = [];
  for (let v = 0; v < LOW; v++) {
    const cos = COS_TABLE[v]!;
    for (let u = 0; u < LOW; u++) {
      let sum = 0;
      for (let y = 0; y < PHASH_SIZE; y++) sum += rows[y]![u]! * cos[y]!;
      coeffs.push(sum);
    }
  }
  // Median tanpa komponen DC (kecerahan rata-rata) agar tahan perubahan brightness.
  const sorted = coeffs.slice(1).sort((a, b) => a - b);
  const median = (sorted[31]! + sorted[32]!) / 2;

  let bits = 0n;
  for (const c of coeffs) bits = (bits << 1n) | (c > median ? 1n : 0n);
  return bits.toString(16).padStart(16, "0");
}

/** Jarak Hamming antara dua hash hex 64-bit (0–64). */
export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export function isPerceptualHash(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value);
}
