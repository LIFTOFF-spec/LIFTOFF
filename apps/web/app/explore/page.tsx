import type { Metadata } from "next";
import { PageContainer } from "@/components/ui/primitives";
import { ExploreBrowser, parseFilter } from "@/components/token/explore-browser";

export const metadata: Metadata = { title: "Explore tokens" };

export default async function ExplorePage({ searchParams }: PageProps<"/explore">) {
  const sp = await searchParams;
  return (
    <PageContainer className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="display text-4xl sm:text-5xl">Explore</h1>
        <p className="max-w-2xl text-text-muted">
          Every token launched through LIFTOFF. Market cap, volume and graduation progress are read
          on-chain by the LIFTOFF indexer (including trades made outside LIFTOFF), in each token’s
          pair currency. Burns and reserve balances come from LIFTOFF’s ledger.
        </p>
      </header>
      <ExploreBrowser
        basePath="/explore"
        filter={parseFilter(sp.filter)}
        pair={typeof sp.pair === "string" ? sp.pair : undefined}
        view={sp.view === "table" ? "table" : "cards"}
      />
    </PageContainer>
  );
}
