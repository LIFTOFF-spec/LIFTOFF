"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Button } from "./primitives";

/** Dialog konfirmasi berbasis <dialog> native (fokus & Esc ditangani browser). */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onCancel();
      }}
      aria-labelledby="confirm-dialog-title"
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-[var(--radius-card)] border-2 border-ink bg-surface p-0 text-text shadow-[var(--shadow-brutal)] backdrop:bg-ink/50"
    >
      <div className="flex flex-col gap-4 p-5">
        <h2 id="confirm-dialog-title" className="display text-xl">
          {title}
        </h2>
        {children && <div className="text-sm text-text-muted">{children}</div>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy}>
            {busy ? "Processing…" : confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
