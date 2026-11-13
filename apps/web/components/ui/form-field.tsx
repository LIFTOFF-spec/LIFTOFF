import type { ReactNode } from "react";
import { cn } from "./primitives";

export type FieldState = "idle" | "checking" | "ok" | "error";

export interface FieldControlProps {
  id: string;
  "aria-invalid": boolean;
  "aria-describedby": string | undefined;
  className: string;
}

/**
 * Label + kontrol + hint/error. Kontrol dirender lewat `children` sehingga bisa
 * berupa input, textarea, atau select dengan atribut aksesibilitas yang sama.
 */
export function FormField({
  id,
  label,
  hint,
  error,
  state = "idle",
  required,
  prefix,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  state?: FieldState;
  required?: boolean;
  prefix?: string;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  const controlClass = cn(
    "w-full rounded-lg border-2 bg-surface px-3 py-2.5 text-sm text-text placeholder:text-text-subtle outline-none transition focus:border-ink",
    error ? "border-danger/70" : state === "ok" ? "border-success/50" : "border-line",
    prefix && "pl-7",
  );

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="flex items-center justify-between gap-2 text-sm font-medium">
        <span>
          {label}
          {required && <span className="text-text-subtle"> *</span>}
        </span>
        {state === "checking" && <span className="text-xs text-text-subtle">Checking…</span>}
        {state === "ok" && <span className="text-xs text-success">✓ Passed check</span>}
      </label>
      <div className="relative">
        {prefix && (
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-text-subtle">
            {prefix}
          </span>
        )}
        {children({
          id,
          "aria-invalid": Boolean(error),
          "aria-describedby": describedBy || undefined,
          className: controlClass,
        })}
      </div>
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-text-subtle">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
