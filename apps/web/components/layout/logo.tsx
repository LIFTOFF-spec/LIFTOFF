import { cn } from "../ui/primitives";

/** Logo LIFTOFF: lengkung ganda hitam + bintang emas (dijiplak dari aset brand, sama dengan app/icon.svg). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="130 90 320 320" aria-hidden className={cn("size-7", className)}>
      <path
        className="fill-ink"
        d="M286 112 L286 228 C286 290 200 340 148 376 L140 320 C190 285 245 255 245 205 L245 145 C245 125 260 112 275 112 Z"
      />
      <path
        className="fill-ink"
        transform="matrix(-1 0 0 1 580 0)"
        d="M286 112 L286 228 C286 290 200 340 148 376 L140 320 C190 285 245 255 245 205 L245 145 C245 125 260 112 275 112 Z"
      />
      <path
        className="fill-gold"
        d="M290 262 Q298 317 355 325 Q298 333 290 390 Q282 333 225 325 Q282 317 290 262 Z"
      />
    </svg>
  );
}

export function Logo({ className, withText = true }: { className?: string; withText?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark />
      {withText && <span className="display text-lg">LIFTOFF.</span>}
    </span>
  );
}
