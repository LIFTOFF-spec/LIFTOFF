"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "./primitives";

/** Tooltip yang bisa dibuka dengan hover, fokus keyboard, atau tap (mobile). */
export function Tooltip({
  content,
  children,
  label = "info",
  className,
}: {
  content: ReactNode;
  children?: ReactNode;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex size-4 items-center justify-center rounded-full border border-line-strong text-[10px] text-text-subtle hover:border-ink hover:text-text"
      >
        {children ?? "?"}
      </button>
      {open && (
        <span
          role="tooltip"
          id={id}
          className="absolute bottom-full left-1/2 z-30 mb-2 w-60 max-w-[80vw] -translate-x-1/2 rounded-lg border-2 border-ink bg-surface p-2.5 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-text shadow-[var(--shadow-brutal-sm)]"
        >
          {content}
        </span>
      )}
    </span>
  );
}
