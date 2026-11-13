import { DISCOVERY_FILTERS } from "@liftoff/shared";
import type { DiscoveryFilter } from "@liftoff/shared";
import Link from "next/link";
import { Suspense } from "react";
import { FilterBar } from "@/components/ui/filter-bar";
import { ButtonLink, SectionTitle } from "@/components/ui/primitives";
import { EmptyState, Skeleton } from "@/components/ui/states";
import { getTokens, getUsedPairs } from "@/lib/api";
import { pairLabel } from "@/lib/format";
import { TokenCard } from "./token-card";
import { TokenTable } from "./token-table";

/** Kategori discovery Spec §15. */
export const FILTER_LABELS: Record<DiscoveryFilter, string> = {
  new: "New launches",
  trending: "Trending",
  graduating: "Graduating soon",
  graduated: "Graduated",
  "top-burns": "Top burns",
  "top-reserves": "Top reserves",
  reinforced: "Liquidity reinforced",
};

export function parseFilter(value: unknown): DiscoveryFilter {
  return (DISCOVERY_FILTERS as readonly string[]).includes(String(value))
    ? (value as DiscoveryFilter)
    : "new";
}

/** Penjelajah token: kategori §15, filter pair (dinamis), tampilan kartu / tabel. */
export function ExploreBrowser({
  basePath,
  filter,
  pair,
  view,
}: {
  basePath: string;
  filter: DiscoveryFilter;
  pair: string | undefined;
  view: "cards" | "table";
}) {
  return (
    <section id="explore" aria-labelledby="explore-title" className="scroll-mt-20">
      <SectionTitle
        id="explore-title"
        aside={
          <div className="flex gap-1 text-xs" role="group" aria-label="View">
            {(["cards", "table"] as const).map((v) => {
              const params = new URLSearchParams();
              if (filter !== "new") params.set("filter", filter);
              if (pair) params.set("pair", pair);
              if (v === "table") params.set("view", "table");
              const qs = params.toString();
              return (
                <Link
                  key={v}
                  href={`${basePath}${qs ? `?${qs}` : ""}`}
                  scroll={false}
                  aria-current={view === v ? "true" : undefined}
                  className={
                    view === v
                      ? "rounded-full bg-ink px-3 py-1 font-medium text-bg"
                      : "rounded-full px-3 py-1 text-text-muted hover:bg-surface-2 hover:text-text"
                  }
                >
                  {v === "cards" ? "Cards" : "Table"}
                </Link>
              );
            })}
          </div>
        }
      >
        Explore tokens
      </SectionTitle>
      <div className="flex flex-col gap-3">
        <FilterBar
          basePath={basePath}
          label="Discovery categories"
          param="filter"
          active={filter === "new" ? "" : filter}
          otherParams={{ pair, view: view === "table" ? "table" : undefined }}
          options={DISCOVERY_FILTERS.map((f) => ({
            value: f === "new" ? "" : f,
            label: FILTER_LABELS[f],
          }))}
        />
        <Suspense fallback={<Skeleton className="h-8 w-64" />}>
          <PairFilter basePath={basePath} filter={filter} pair={pair} view={view} />
        </Suspense>
      </div>
      <div className="mt-5">
        <Suspense key={`${filter}-${pair}-${view}`} fallback={<ListSkeleton />}>
          <TokenList basePath={basePath} filter={filter} pair={pair} view={view} />
        </Suspense>
      </div>
    </section>
  );
}

async function PairFilter({
  basePath,
  filter,
  pair,
  view,
}: {
  basePath: string;
  filter: DiscoveryFilter;
  pair: string | undefined;
  view: string;
}) {
  // Hanya quote yang dipakai token live: daftar StonkFun ratusan pair tidak muat sebagai filter.
  const res = await getUsedPairs().catch(() => null);
  if (!res) return null;
  const pairs = res.data;
  return (
    <FilterBar
      basePath={basePath}
      label="Pair filter"
      param="pair"
      active={pair ?? ""}
      otherParams={{
        filter: filter === "new" ? undefined : filter,
        view: view === "table" ? "table" : undefined,
      }}
      options={[
        { value: "", label: "All pairs" },
        ...pairs.map((p) => ({ value: p.id, label: pairLabel(p, pairs) })),
      ]}
    />
  );
}

export async function TokenList({
  basePath,
  filter,
  pair,
  view,
  limit,
}: {
  basePath: string;
  filter: DiscoveryFilter;
  pair?: string | undefined;
  view: "cards" | "table";
  limit?: number;
}) {
  const { data } = await getTokens({ filter, pair });
  const items = limit ? data.items.slice(0, limit) : data.items;
  if (items.length === 0) {
    return (
      <EmptyState
        title="No tokens in this category yet"
        description="Try another category or pair."
        action={
          <ButtonLink href={basePath} scroll={false}>
            Reset filters
          </ButtonLink>
        }
      />
    );
  }
  if (view === "table") return <TokenTable tokens={items} />;
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((t) => (
        <li key={t.id}>
          <TokenCard token={t} />
        </li>
      ))}
    </ul>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-52 rounded-xl" />
      ))}
    </div>
  );
}
