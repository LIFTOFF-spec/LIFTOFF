import {
  FEE_CONFIG,
  RESERVE_CONFIG,
  RESERVE_SAFETY_CHECKS,
  type ReserveSafetyCheck,
} from "@liftoff/shared";
import type { Metadata } from "next";
import Image from "next/image";
import { Suspense } from "react";
import { Tag } from "@/components/ui/badges";
import { ButtonLink, Card, PageContainer, SectionTitle } from "@/components/ui/primitives";
import { ListSkeleton, TokenList } from "@/components/token/explore-browser";
import { ReserveDeploymentList } from "@/components/token/reserve-deployments";
import { StatCard } from "@/components/ui/stat-card";
import { ErrorState } from "@/components/ui/states";
import { getReserveOverview } from "@/lib/api";
import { clusterCopy } from "@/lib/cluster";
import { SolPriceNote } from "@/components/ui/sol-price-note";
import { formatBps, formatDuration, formatUsd, getCluster } from "@/lib/format";

export const metadata: Metadata = { title: "Conviction Reserve" };

const SAFETY_LABELS: Record<ReserveSafetyCheck, string> = {
  pool_active: "Pool is active",
  token_graduated: "Token is graduated",
  swap_route_available: "Swap routes are available",
  reserve_sufficient: "Reserve balance is sufficient",
  price_data_reliable: "Price data is reliable",
  pool_state_normal: "No abnormal pool state is detected",
};

const PHASES = [
  {
    n: "1",
    title: "Reserve accumulation",
    body: `${formatBps(FEE_CONFIG.split.convictionReserve)} of every eligible creator fee is credited to that token’s own reserve. Token A’s reserve is never used for token B.`,
  },
  {
    n: "2",
    title: "Liquidity monitoring",
    body: "After graduation, LIFTOFF watches pool liquidity, depth, estimated price impact, volume changes, the reserve balance and graduation status.",
  },
  {
    n: "3",
    title: "Liquidity reinforcement",
    body: "When the conditions below are met, part of the reserve is converted into the token and quote asset and added to a compatible pool.",
  },
  {
    n: "4",
    title: "Liquidity lock",
    body: "Reserve-funded liquidity must be locked by an enforceable mechanism. LIFTOFF never claims a permanent lock unless it is enforced on-chain.",
  },
  {
    n: "5",
    title: "Public verification",
    body: "Each deployment shows the token, mint, reserve before, amount deployed, pool address, transaction signature, lock proof and remaining reserve.",
  },
];

export default function ConvictionReservePage() {
  const r = RESERVE_CONFIG;
  return (
    <PageContainer className="flex max-w-5xl flex-col gap-10">
      <header className="grid items-center gap-6 md:grid-cols-[1.1fr_1fr]">
        <div className="flex flex-col gap-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-text-subtle">
            LIFTOFF’s signature feature
          </p>
          <h1 className="display text-[2rem] min-[400px]:text-4xl sm:text-5xl">
            Conviction Reserve.
          </h1>
          <p className="text-lg text-text-muted">
            An automated liquidity reinforcement mechanism funded by{" "}
            {formatBps(FEE_CONFIG.split.convictionReserve)} of each token’s trading-generated
            creator fees. The other {formatBps(FEE_CONFIG.split.buybackBurn)} funds buyback &amp;
            burn.
          </p>
          <p className="rounded-xl border-2 border-ink bg-surface p-3 text-sm">
            It reinforces liquidity. It does not defend a market cap or price, and it is not a price
            stabilization guarantee.
          </p>
        </div>
        <Image
          src="/brand/conviction-reserve.webp"
          alt="Shape characters carry blue coins into a large glass jar."
          width={1200}
          height={655}
          sizes="(min-width: 768px) 440px, 100vw"
          className="h-auto w-full"
        />
      </header>

      <section aria-labelledby="phases-title">
        <SectionTitle id="phases-title">How it works</SectionTitle>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {PHASES.map((p) => (
            <li key={p.n}>
              <Card className="h-full p-4">
                <p className="num text-sm font-semibold text-reserve">Phase {p.n}</p>
                <p className="mt-1 font-semibold">{p.title}</p>
                <p className="mt-2 text-sm text-text-muted">{p.body}</p>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="rules-title" className="grid gap-3 md:grid-cols-2">
        <Card className="p-4 text-sm text-text-muted">
          <h2
            id="rules-title"
            className="mb-2 flex flex-wrap items-center gap-2 font-semibold text-text"
          >
            Deployment rules
            {r.status === "unverified" && <Tag tone="warn">Starting assumptions</Tag>}
          </h2>
          <ul className="flex flex-col gap-1.5">
            <li>
              Minimum reserve threshold:{" "}
              <span className="num text-text">{formatUsd(r.minBalanceToDeployUsd, false)}</span>
            </li>
            <li>
              Maximum deployment per cycle:{" "}
              <span className="num text-text">{formatBps(r.maxDeployPctPerRunBps)}</span> of the
              available reserve
            </li>
            <li>
              Cooldown between deployments:{" "}
              <span className="num text-text">{formatDuration(r.cooldownSeconds)}</span>
            </li>
            <li>
              Liquidity condition: considered only when measured pool liquidity is below{" "}
              <span className="num text-text">
                {formatUsd(r.deployWhenLiquidityBelowUsd, false)}
              </span>
            </li>
          </ul>
          <p className="mt-3 text-xs text-text-subtle">
            These thresholds are the spec’s starting values and must be validated through simulation
            and testing before activation.
          </p>
        </Card>
        <Card className="p-4 text-sm text-text-muted">
          <h2 className="mb-2 font-semibold text-text">Market safety checks</h2>
          <p className="mb-2">Before any deployment, all of these must pass:</p>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {RESERVE_SAFETY_CHECKS.map((c) => (
              <li key={c}>{SAFETY_LABELS[c]}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-text-subtle">
            During abnormal market conditions the reserve waits until the checks pass. Deployment
            stays disabled until the graduated pool is verified to support the required liquidity
            operations.
          </p>
        </Card>
        <Card className="p-4 text-sm text-text-muted md:col-span-2">
          <h2 className="mb-2 font-semibold text-text">Extra safety limits</h2>
          <ul className="flex flex-col gap-1.5">
            <li>
              Per-deployment cap:{" "}
              <span className="num text-text">{formatUsd(r.maxDeployAbsPerRunUsd, false)}</span>;
              reserve at most{" "}
              <span className="num text-text">{formatBps(r.maxReserveShareOfPoolBps)}</span> of the
              pool; waiting period after graduation{" "}
              <span className="num text-text">
                {formatDuration(r.minTimeSinceGraduationSeconds)}
              </span>
              .
            </li>
            <li>
              Tokens that never graduate keep their reserve untouched. It is only used after
              graduation and pool verification.
            </li>
          </ul>
        </Card>
      </section>

      <section aria-labelledby="status-title">
        <SectionTitle id="status-title">Status on this network</SectionTitle>
        <Card className="p-4 text-sm text-text-muted">
          <ul className="flex list-disc flex-col gap-1.5 pl-5">
            <li>
              Reserve accounting per token: live (append-only ledger, from verified creator fees).
            </li>
            <li>
              Reserve custody: each token’s reserve sits in its own SPL token account, derived from
              the token mint and controlled by the LIFTOFF signer. This is the spec’s simpler MVP
              option with weaker trust guarantees than an on-chain vault program, which is not
              deployed.
            </li>
            <li>{clusterCopy(getCluster()).reserveDeploymentStatus}</li>
            <SolPriceNote />
          </ul>
        </Card>
      </section>

      <section aria-labelledby="deployments-title">
        <SectionTitle id="deployments-title">Deployment history</SectionTitle>
        <Suspense fallback={<ListSkeleton rows={2} />}>
          <DeploymentHistory />
        </Suspense>
      </section>

      <section aria-labelledby="top-title">
        <SectionTitle
          id="top-title"
          aside={
            <ButtonLink href="/explore?filter=top-reserves" className="text-sm">
              All
            </ButtonLink>
          }
        >
          Top reserves
        </SectionTitle>
        <Suspense fallback={<ListSkeleton rows={3} />}>
          <TokenList basePath="/explore" filter="top-reserves" view="cards" limit={6} />
        </Suspense>
      </section>
    </PageContainer>
  );
}

async function DeploymentHistory() {
  const res = await getReserveOverview().catch(() => null);
  if (!res) {
    return (
      <ErrorState title="Deployment history is unavailable" description="Try again shortly." />
    );
  }
  const o = res.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-3">
        <StatCard
          label="Total liquidity reinforced"
          stat={o.totalDeployedUsd}
          definition={clusterCopy(getCluster()).reserveDeployedDefinition}
          footer={
            <span className="num text-xs text-text-subtle">
              {o.totalDeployedNative.map((s) => `${s.value} ${s.unit}`).join(" · ") || "0"}
            </span>
          }
        />
        <Card className="p-4">
          <p className="text-xs text-text-muted">Tokens with liquidity reinforced</p>
          <p className="num mt-1 text-2xl font-semibold">{o.tokensReinforced}</p>
          <p className="mt-1 text-xs text-text-subtle">Only deployments with a proven LP burn.</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-text-muted">Deployment rules</p>
          <p className="mt-1 font-semibold">
            {o.configStatus === "verified" ? "Simulated & verified" : "Starting assumptions"}
          </p>
          <p className="mt-1 text-xs text-text-subtle">Spec §12 thresholds, see above.</p>
        </Card>
      </div>
      <ReserveDeploymentList deployments={o.deployments} />
    </div>
  );
}
