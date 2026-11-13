import type { ActivityItem, Stat } from "@liftoff/shared";
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { Tag } from "@/components/ui/badges";
import { ContractAddress } from "@/components/ui/contract-address";
import { ButtonLink, Card, PageContainer, SectionTitle } from "@/components/ui/primitives";
import { StatCard, StatValue } from "@/components/ui/stat-card";
import { EmptyState, Skeleton } from "@/components/ui/states";
import { RelativeTime } from "@/components/ui/time";
import { ListSkeleton, TokenList } from "@/components/token/explore-browser";
import { VerifiedStats } from "@/components/token/verified-stats";
import { DependencyNotice } from "@/components/layout/dependency-notice";
import { getActivity, getPlatformStats, getTransparency } from "@/lib/api";
import { clusterCopy } from "@/lib/cluster";
import { explorerUrl, formatAmount, formatCompact, formatUsd, getCluster } from "@/lib/format";

export default function HomePage() {
  return (
    <>
      <Hero />
      <PageContainer className="flex flex-col gap-12 pt-0 sm:pt-0">
        <Suspense fallback={<StatsSkeleton />}>
          <LiveStats />
        </Suspense>

        <Suspense fallback={<VerifiedSkeleton />}>
          <HomeVerifiedStats />
        </Suspense>

        <section aria-labelledby="new-title">
          <SectionTitle
            id="new-title"
            aside={
              <Link href="/explore" className="text-sm font-medium hover:underline">
                All tokens →
              </Link>
            }
          >
            New launches
          </SectionTitle>
          <Suspense fallback={<ListSkeleton rows={3} />}>
            <TokenList basePath="/explore" filter="new" view="cards" limit={6} />
          </Suspense>
        </section>

        <section aria-labelledby="activity-title">
          <SectionTitle id="activity-title">Recent activity</SectionTitle>
          <Suspense fallback={<ListSkeleton rows={4} />}>
            <ActivityFeed />
          </Suspense>
        </section>

        <DependencyNotice />
      </PageContainer>
    </>
  );
}

function Hero() {
  return (
    <section className="border-b-2 border-ink">
      <div className="mx-auto grid max-w-6xl items-center gap-6 px-4 pt-10 pb-8 sm:px-6 md:grid-cols-[1.05fr_1fr] md:pt-14 md:pb-12">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-wrap gap-2">
            <Tag>Solana</Tag>
            <Tag>Built on StonkFun &amp; Raydium</Tag>
            <Tag>{getCluster()}</Tag>
          </div>
          <h1 className="display text-[2.125rem] min-[400px]:text-4xl sm:text-6xl">
            LAUNCH FAIR<span className="text-accent">.</span>
            <br />
            BUILD STRONGER<span className="text-accent">.</span>
          </h1>
          <p className="max-w-xl text-text-muted sm:text-lg">
            Launch tokens on Solana with automated buyback, burn, and liquidity reinforcement.
          </p>
          <div className="flex flex-col gap-3 min-[400px]:flex-row">
            <ButtonLink href="/create" variant="primary" className="px-6 py-3 text-base">
              Launch Token
            </ButtonLink>
            <ButtonLink href="/explore" className="px-6 py-3 text-base">
              Explore Tokens
            </ButtonLink>
          </div>
          <ContractAddress />
        </div>
        <div className="mx-auto w-full max-w-[520px]">
          {/* Video brand (Asset/Main.mp4, logo bawaan ditutup & latar disamakan ke krem).
              Tepi dipudarkan supaya batas video tidak terlihat. */}
          <video
            className="block aspect-[478/270] w-full object-contain [mask-image:linear-gradient(to_right,transparent,black_5%,black_95%,transparent)] motion-reduce:hidden"
            src="/brand/hero.mp4"
            poster="/brand/fair-launch.webp"
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            aria-label="A red rocket character launches from the LIFTOFF launch pad while fees flow into a burn fire and a reserve jar."
          />
          {/* prefers-reduced-motion: ilustrasi diam saja. */}
          <Image
            src="/brand/fair-launch.webp"
            alt="A round red character launches off a black launch pad while blue triangle, circle, and square friends cheer."
            width={1200}
            height={872}
            sizes="(min-width: 768px) 520px, 100vw"
            className="hidden h-auto w-full motion-reduce:block"
          />
        </div>
      </div>
    </section>
  );
}

/** Jumlah native per pair (verified, on-chain) di bawah estimasi USD. */
function NativeBreakdown({ stats }: { stats: Stat[] }) {
  if (stats.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-text-muted">
      {stats.map((s) => (
        <li key={s.unit} className="num">
          {formatAmount(s.value ?? "0")} {s.unit}
          {s.status === "delayed" && <span className="ml-1 text-warn">(delayed)</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Spec §17 Live Statistics — dari data terverifikasi: ledger & trade on-chain terindeks (termasuk
 * trade di luar UI LIFTOFF). Total USD memakai harga asumsi pair (MOCK; mainnet: tidak tersedia);
 * jumlah native di bawahnya.
 */
async function LiveStats() {
  const { data } = await getPlatformStats();
  return (
    <section
      aria-label="Live statistics"
      className="grid grid-cols-1 gap-3 pt-8 min-[420px]:grid-cols-2 lg:grid-cols-5"
    >
      <StatCard
        label="Total tokens launched"
        stat={data.tokensLaunched}
        definition="Tokens that went live through LIFTOFF, verified on-chain at launch."
        format={(v) => v}
      />
      <StatCard
        label="Total trading volume"
        stat={data.tradingVolumeUsd}
        definition={clusterCopy(getCluster()).statVolumeDefinition}
        footer={<NativeBreakdown stats={data.native.tradingVolume} />}
      />
      <StatCard
        label="Total tokens burned"
        stat={data.tokensBurned}
        definition="Tokens bought back and burned, counted only from confirmed on-chain burn transactions."
        format={(v) => formatCompact(v)}
      />
      <StatCard
        label="Total reserve accumulated"
        stat={data.reserveAccumulatedUsd}
        definition="Creator-fee share credited to each token’s Conviction Reserve (USD estimate)."
        footer={<NativeBreakdown stats={data.native.reserveAccumulated} />}
      />
      <StatCard
        label="Total liquidity reinforced"
        stat={data.liquidityReinforcedUsd}
        definition="Reserve funds deployed as pool liquidity after graduation (USD estimate)."
        footer={<NativeBreakdown stats={data.native.liquidityReinforced} />}
        className="min-[420px]:col-span-2 lg:col-span-1"
      />
    </section>
  );
}

/** Kartu Verified dari halaman Transparency (keputusan pemilik, menggantikan How It Works 01–04). */
async function HomeVerifiedStats() {
  const { data } = await getTransparency();
  return <VerifiedStats verified={data.verified} title="Transparency" />;
}

const KIND_TONE: Record<ActivityItem["kind"], "neutral" | "burn" | "accent" | "reserve"> = {
  trade: "neutral",
  burn: "burn",
  launch: "accent",
  reserve: "reserve",
};

async function ActivityFeed() {
  const { data } = await getActivity(10);
  if (data.length === 0) {
    return (
      <EmptyState title="No activity yet" description="Launches, fees and burns show up here." />
    );
  }
  return (
    <Card className="divide-y divide-line">
      {data.map((a) => (
        <div key={a.id} className="flex items-center gap-3 px-4 py-3 text-sm">
          <Tag tone={KIND_TONE[a.kind]} className="w-16 justify-center">
            {a.kind}
          </Tag>
          <Link href={`/token/${a.tokenMint}`} className="min-w-0 flex-1 truncate hover:underline">
            {a.summary}
          </Link>
          <span className="hidden text-right sm:block">
            <StatValue stat={a.amountUsd} format={(v) => formatUsd(v)} />
          </span>
          <a
            href={explorerUrl("tx", a.signature)}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-xs text-text-subtle hover:text-text"
            title={`View on Solana Explorer (${getCluster()})`}
          >
            <RelativeTime iso={a.createdAt} /> ↗
          </a>
        </div>
      ))}
    </Card>
  );
}

function VerifiedSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-[118px] rounded-xl" />
      ))}
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 pt-8 min-[420px]:grid-cols-2 lg:grid-cols-5">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-[118px] rounded-xl" />
      ))}
    </div>
  );
}
