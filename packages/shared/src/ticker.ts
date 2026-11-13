/**
 * Normalisasi ticker untuk anti-copycat (P4).
 *
 * Dua ticker dianggap SAMA jika bentuk ternormalisasinya sama. Bentuk ini yang disimpan di
 * `ticker_claims.tickerNormalized` (unique untuk klaim aktif), sehingga varian huruf besar/kecil,
 * spasi/tanda baca, homoglyph Unicode, dan leetspeak tidak bisa lolos.
 *
 * Urutan langkah:
 *  1. NFKC (lebar penuh, huruf matematis, ligatur → bentuk dasar).
 *  2. Buang sigil `$` di depan ($PEPE → PEPE).
 *  3. Huruf kecil, lalu buang tanda diakritik (é → e).
 *  4. Lipat homoglyph (Cyrillic/Greek/dll. yang mirip huruf Latin).
 *  5. Lipat leetspeak & simbol (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s, ...).
 *  6. Satukan kelas huruf yang tampak sama: `l` dan `i` (dan `1`, `|`, `!`) → `i`.
 *  7. Buang semua yang bukan a–z (spasi, tanda baca, karakter zero-width, emoji).
 *
 * Langkah 6 sengaja konservatif: "PEPL" dan "PEPI" dianggap sama karena `1` bisa dibaca
 * sebagai I maupun L. Lebih baik menolak satu ticker sah daripada meloloskan peniru.
 *
 * Tabel homoglyph tidak pernah lengkap; karena itu API juga menolak ticker yang memakai
 * karakter di luar A–Z/0–9 (`isAsciiTicker`) sebagai lapisan kedua.
 */

/** Huruf non-Latin yang tampak seperti huruf Latin (huruf kecil, setelah toLowerCase). */
const HOMOGLYPHS: Record<string, string> = {
  // Cyrillic
  а: "a",
  в: "b",
  б: "b",
  с: "c",
  ԁ: "d",
  е: "e",
  ё: "e",
  һ: "h",
  н: "h",
  і: "i",
  ї: "i",
  ј: "j",
  к: "k",
  ӏ: "l",
  м: "m",
  п: "n",
  о: "o",
  р: "p",
  ԛ: "q",
  г: "r",
  ѕ: "s",
  т: "t",
  у: "y",
  ү: "y",
  х: "x",
  ԝ: "w",
  ѡ: "w",
  з: "e",
  // Greek
  α: "a",
  β: "b",
  ϲ: "c",
  δ: "d",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  μ: "m",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ω: "w",
  ζ: "z",
  γ: "y",
  // Armenian & lainnya yang sering dipakai menyamar
  օ: "o",
  ս: "u",
  ց: "g",
  հ: "h",
  ո: "n",
  // Lisu (huruf kapital yang identik dengan Latin)
  ꓮ: "a",
  ꓐ: "b",
  ꓚ: "c",
  ꓓ: "d",
  ꓰ: "e",
  ꓝ: "f",
  ꓖ: "g",
  ꓧ: "h",
  ꓲ: "i",
  ꓙ: "j",
  ꓗ: "k",
  ꓡ: "l",
  ꓟ: "m",
  ꓠ: "n",
  ꓳ: "o",
  ꓑ: "p",
  ꓣ: "r",
  ꓢ: "s",
  ꓔ: "t",
  ꓴ: "u",
  ꓦ: "v",
  ꓪ: "w",
  ꓫ: "x",
  ꓬ: "y",
  ꓜ: "z",
  // Latin varian
  ı: "i",
  ȷ: "j",
  ɡ: "g",
  ɑ: "a",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ł: "l",
};

/** Leetspeak & simbol → huruf. `1`, `|`, `!` dipetakan ke `i` (lihat langkah 6). */
const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "2": "z",
  "3": "e",
  "4": "a",
  "5": "s",
  "6": "g",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  $: "s",
  "|": "i",
  "!": "i",
  "€": "e",
  "£": "l",
  "¥": "y",
};

/** Kelas huruf yang dianggap sama secara visual. */
const LOOKALIKE: Record<string, string> = { l: "i" };

const COMBINING_MARKS = /\p{M}/gu;

function fold(raw: string, lookalikes: boolean, leet: Record<string, string>): string {
  let s = raw.normalize("NFKC").trim();
  s = s.replace(/^\$+/, "");
  s = s.toLowerCase().normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC");

  let out = "";
  for (const ch of s) {
    let c = HOMOGLYPHS[ch] ?? ch;
    c = leet[c] ?? c;
    for (const part of c) {
      const folded = lookalikes ? (LOOKALIKE[part] ?? part) : part;
      if (folded >= "a" && folded <= "z") out += folded;
    }
  }
  return out;
}

export function normalizeTicker(raw: string): string {
  return fold(raw, true, LEET);
}

/**
 * Kata kunci pencarian di sumber data pasar eksternal (mis. Jupiter) untuk sebuah ticker:
 * bentuk tampilan apa adanya, plus versi tanpa leetspeak (`1` dibaca I dan L). Hasil pencarian
 * tetap dicocokkan dengan `normalizeTicker`; varian ini hanya memperluas pencarian.
 */
export function tickerSearchTerms(raw: string): string[] {
  const display = raw.trim().replace(/^\$+/, "").toUpperCase();
  const asI = fold(raw, false, LEET).toUpperCase();
  const asL = fold(raw, false, { ...LEET, "1": "l", "|": "l" }).toUpperCase();
  return [...new Set([display, asI, asL].filter((t) => t.length > 0))];
}

/** Ticker hanya boleh memakai huruf A–Z dan angka 0–9 setelah dibersihkan dari `$` dan spasi. */
export function isAsciiTicker(raw: string): boolean {
  return /^[A-Za-z0-9]+$/.test(raw.trim().replace(/^\$+/, ""));
}

/** Bentuk tampilan: huruf besar, tanpa `$`, tanpa spasi di tepi. */
export function displayTicker(raw: string): string {
  return raw.trim().replace(/^\$+/, "").toUpperCase();
}

export const TICKER_MIN_NORMALIZED_LENGTH = 2;
export const TICKER_MAX_LENGTH = 10;
