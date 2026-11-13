import { cn } from "../ui/primitives";

// Palet brand: merah-oranye, kobalt, hitam, emas (sesuai karakter di ilustrasi).
const SWATCHES = [
  "bg-accent text-ink",
  "bg-cobalt text-white",
  "bg-ink text-bg",
  "bg-gold text-ink",
];

function swatchOf(ticker: string) {
  let h = 0;
  for (const ch of ticker) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SWATCHES[h % SWATCHES.length] ?? SWATCHES[0];
}

/** Avatar token. Mock tidak punya gambar, jadi pakai inisial berwarna. */
export function TokenAvatar({
  ticker,
  imageUrl,
  size = "md",
  className,
}: {
  ticker: string;
  imageUrl: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const sizes = { sm: "size-8 text-[10px]", md: "size-10 text-xs", lg: "size-14 text-sm" };
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- gambar token dari API (domain belum pasti)
      <img
        src={imageUrl}
        alt={`${ticker} logo`}
        className={cn(
          "shrink-0 rounded-full border-2 border-ink object-cover",
          sizes[size],
          className,
        )}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border-2 border-ink font-mono font-bold",
        swatchOf(ticker),
        sizes[size],
        className,
      )}
    >
      {ticker.slice(0, 2)}
    </span>
  );
}
