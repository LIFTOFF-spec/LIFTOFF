import Link from "next/link";
import { cn } from "./primitives";

export interface FilterOption {
  value: string;
  label: string;
}

/** Baris filter berbasis URL (`?filter=…&pair=…`), bisa di-share & di-bookmark. */
export function FilterBar({
  basePath,
  options,
  active,
  param,
  otherParams = {},
  label,
  className,
}: {
  basePath: string;
  options: FilterOption[];
  active: string | undefined;
  param: string;
  otherParams?: Record<string, string | undefined>;
  label: string;
  className?: string;
}) {
  function href(value: string | undefined) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(otherParams)) if (v) params.set(k, v);
    if (value) params.set(param, value);
    const qs = params.toString();
    return `${basePath}${qs ? `?${qs}` : ""}#explore`;
  }

  return (
    <nav aria-label={label} className={cn("-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0", className)}>
      <ul className="flex w-max gap-1.5">
        {options.map((opt) => {
          const isActive = opt.value === (active ?? "");
          return (
            <li key={opt.value || "all"}>
              <Link
                href={href(opt.value || undefined)}
                scroll={false}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "inline-flex rounded-full border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition",
                  isActive
                    ? "border-ink bg-ink text-bg"
                    : "border-line-strong bg-surface text-text-muted hover:border-ink hover:text-text",
                )}
              >
                {opt.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
