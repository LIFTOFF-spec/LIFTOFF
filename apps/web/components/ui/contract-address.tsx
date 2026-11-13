"use client";

import { useState } from "react";

/** Alamat kontrak (CA) token LIFTOFF, ditampilkan di hero beranda. */
export const LIFTOFF_CA = "F1qYV1KEi3J5kDSBnSfSyC9ZtduHE4iauhsErA3BQNnW";

/** Cadangan saat Clipboard API ditolak (konteks tidak aman / izin browser). */
function legacyCopy(text: string): boolean {
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    el.remove();
  }
}

export function ContractAddress({ address = LIFTOFF_CA }: { address?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(address);
      ok = true;
    } catch {
      ok = legacyCopy(address);
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="flex w-full max-w-xl min-w-0 items-center gap-2 rounded-full border-2 border-ink bg-surface py-1.5 pr-1.5 pl-4 text-sm">
      <span className="shrink-0 font-semibold">CA</span>
      <code
        className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted select-all sm:text-sm"
        title={address}
      >
        {address}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy contract address"
        className="shrink-0 rounded-full border-2 border-ink px-3 py-1 text-xs font-semibold transition-colors hover:bg-ink hover:text-surface"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
