import type { Pair } from "@liftoff/shared";

/** Cocok bila semua kata ada di simbol, nama, kategori, atau mint. */
export function filterPairs(pairs: Pair[], query: string, category: string): Pair[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return pairs.filter((p) => {
    if (category && p.category !== category) return false;
    const text = `${p.symbol} ${p.name} ${p.categoryLabel ?? ""} ${p.mint}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
