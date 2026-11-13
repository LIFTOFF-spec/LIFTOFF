import Image from "next/image";
import type { ReactNode } from "react";
import { cn } from "./primitives";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-surface-2", className)} />;
}

export function EmptyState({
  title,
  description,
  action,
  className,
  illustration = "/brand/anti-copycat.webp",
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** Ilustrasi brand; null untuk menyembunyikan. */
  illustration?: string | null;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-[var(--radius-card)] border-2 border-dashed border-line-strong px-4 py-8 text-center",
        className,
      )}
    >
      {illustration ? (
        <Image src={illustration} alt="" width={240} height={146} className="mb-1 h-auto w-48" />
      ) : (
        <span aria-hidden className="text-2xl text-text-subtle">
          ∅
        </span>
      )}
      <p className="font-semibold">{title}</p>
      {description && <p className="max-w-sm text-sm text-text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  description,
  action,
  className,
}: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-2 rounded-[var(--radius-card)] border-2 border-danger/40 bg-danger/5 px-4 py-10 text-center",
        className,
      )}
    >
      <span aria-hidden className="display text-3xl text-danger">
        !
      </span>
      <p className="font-semibold">{title}</p>
      {description && <p className="max-w-sm text-sm text-text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
