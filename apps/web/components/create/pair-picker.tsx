"use client";

import type { Pair } from "@liftoff/shared";
import { useMemo, useState } from "react";
import { Tag } from "@/components/ui/badges";
import { cn } from "@/components/ui/primitives";
import { shortAddress } from "@/lib/format";
import { filterPairs } from "@/lib/pair-search";

/** Baris yang dirender sekaligus; StonkFun melaporkan ratusan pair, sisanya lewat pencarian. */
const MAX_ROWS = 40;

function PairLogo({ url }: { url: string | null }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return <span aria-hidden className="size-7 shrink-0 rounded-full border border-line bg-line" />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- logo pihak ketiga, ukuran kecil, lazy
    <img
      src={url}
      alt=""
      width={28}
      height={28}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="size-7 shrink-0 rounded-full border border-line object-cover"
    />
  );
}

export function PairPicker({
  pairs,
  selectedId,
  onSelect,
}: {
  pairs: Pair[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of pairs) if (p.category) seen.set(p.category, p.categoryLabel ?? p.category);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [pairs]);
  const matches = useMemo(() => filterPairs(pairs, query, category), [pairs, query, category]);
  const available = pairs.filter((p) => p.supported).length;
  const rows = matches.slice(0, MAX_ROWS);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="flex-1">
          <span className="sr-only">Search pairs</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by symbol, name or mint"
            className="w-full rounded-xl border-2 border-line bg-surface px-3 py-2 text-sm focus:border-ink focus:outline-none"
          />
        </label>
        {categories.length > 1 && (
          <label>
            <span className="sr-only">Category</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-xl border-2 border-line bg-surface px-3 py-2 text-sm focus:border-ink focus:outline-none sm:w-auto"
            >
              <option value="">All categories</option>
              {categories.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="text-xs text-text-subtle" aria-live="polite">
        {available} of {pairs.length} pairs open for launch · {matches.length} shown by this search
      </p>
      <fieldset className="max-h-[26rem] overflow-y-auto rounded-xl border-2 border-line">
        <legend className="sr-only">Pair</legend>
        {rows.length === 0 && (
          <p className="p-4 text-sm text-text-muted">No pair matches this search.</p>
        )}
        {rows.map((p) => {
          const selected = selectedId === p.id;
          return (
            <label
              key={p.id}
              className={cn(
                "flex cursor-pointer items-start gap-3 border-b border-line p-3 last:border-b-0 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-cobalt",
                !p.supported && "cursor-not-allowed bg-line/20",
                selected && "bg-accent/10",
              )}
            >
              <input
                type="radio"
                name="pair"
                value={p.id}
                checked={selected}
                disabled={!p.supported}
                onChange={() => onSelect(p.id)}
                className="mt-1.5 accent-[var(--color-accent)]"
              />
              <PairLogo url={p.logoUrl} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold break-all">{p.symbol}</span>
                  <span className="min-w-0 text-xs break-words text-text-muted">{p.name}</span>
                  {p.categoryLabel && <Tag tone="neutral">{p.categoryLabel}</Tag>}
                  {p.category === "custom" && <Tag tone="warn">Check mint</Tag>}
                  {p.symbolAmbiguous && <Tag tone="warn">Symbol not unique</Tag>}
                  {!p.supported && <Tag tone="warn">Not available</Tag>}
                </span>
                <span className="num mt-0.5 block text-[11px] text-text-subtle" title={p.mint}>
                  Mint {shortAddress(p.mint, 6)}
                </span>
                {!p.supported && p.unavailableReason && (
                  <span className="mt-1 block text-xs text-text-subtle">{p.unavailableReason}</span>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>
      {matches.length > rows.length && (
        <p className="text-xs text-text-subtle">
          Showing the first {rows.length}. Type to narrow the list.
        </p>
      )}
    </div>
  );
}
