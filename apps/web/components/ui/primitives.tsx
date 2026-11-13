import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

// Tombol bergaya ilustrasi brand: garis hitam tegas + bayangan keras.
const VARIANTS: Record<Variant, string> = {
  primary:
    "border-2 border-ink bg-accent text-accent-ink shadow-[var(--shadow-brutal-sm)] hover:-translate-y-px hover:shadow-[3px_3px_0_0_#111] active:translate-y-px active:shadow-none disabled:border-line-strong disabled:bg-surface-2 disabled:text-text-subtle disabled:shadow-none disabled:translate-y-0",
  secondary:
    "border-2 border-ink bg-surface text-text hover:bg-surface-2 disabled:border-line-strong disabled:text-text-subtle",
  ghost: "text-text-muted hover:bg-surface-2 hover:text-text disabled:text-text-subtle",
  danger: "border-2 border-danger text-danger hover:bg-danger/10",
};

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed";

/** Kelas tombol untuk elemen non-button (mis. <a> ke route API). */
export function buttonClass(variant: Variant = "secondary", className?: string) {
  return cn(BASE, VARIANTS[variant], className);
}

export function Button({
  variant = "secondary",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: Variant }) {
  return <button type="button" className={cn(BASE, VARIANTS[variant], className)} {...props} />;
}

export function ButtonLink({
  variant = "secondary",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={cn(BASE, VARIANTS[variant], className)} {...props} />;
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-[var(--radius-card)] border border-line bg-surface", className)}
      {...props}
    />
  );
}

export function SectionTitle({
  children,
  aside,
  id,
}: {
  children: ReactNode;
  aside?: ReactNode;
  id?: string;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 id={id} className="text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
        {children}
      </h2>
      {aside}
    </div>
  );
}

/** Heading brand besar: Ultra uppercase, teks diakhiri titik oleh pemanggil. */
export function DisplayHeading({
  as: Tag = "h1",
  className,
  ...props
}: ComponentProps<"h1"> & { as?: "h1" | "h2" | "h3" }) {
  return <Tag className={cn("display text-3xl sm:text-4xl", className)} {...props} />;
}

export function PageContainer({ className, ...props }: ComponentProps<"main">) {
  return (
    <main
      className={cn("mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10", className)}
      {...props}
    />
  );
}
