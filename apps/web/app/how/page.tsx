import { FEE_CONFIG, RESERVE_CONFIG } from "@liftoff/shared";
import type { Metadata } from "next";
import Image from "next/image";
import type { ReactNode } from "react";
import { Tag } from "@/components/ui/badges";
import { ButtonLink, Card, PageContainer, cn } from "@/components/ui/primitives";
import { FeeSplitDiagram } from "@/components/token/fee-split-diagram";
import { DependencyNotice } from "@/components/layout/dependency-notice";
import { getPairSummary } from "@/lib/api";
import { clusterCopy } from "@/lib/cluster";
import { bpsOf, formatBps, formatDuration, formatUsd, getCluster } from "@/lib/format";

export const metadata: Metadata = { title: "How it works" };

interface Art {
  src: string;
  width: number;
  height: number;
  alt: string;
}

// Ilustrasi brand (Asset/ → public/brand, teks bawaan sudah dihapus).
const ART = {
  fair: {
    src: "/brand/fair-launch.webp",
    width: 1200,
    height: 872,
    alt: "A red round character jumps off a launch pad while blue shapes cheer.",
  },
  controller: {
    src: "/brand/launch-controller.webp",
    width: 1200,
    height: 695,
    alt: "A red block character stands on a single machine that sends shape characters down one conveyor belt.",
  },
  pairs: {
    src: "/brand/custom-pairs.webp",
    width: 1200,
    height: 598,
    alt: "A red character hops across stepping stones labeled with quote assets.",
  },
  copycat: {
    src: "/brand/anti-copycat.webp",
    width: 1182,
    height: 721,
    alt: "A red character with a shield blocks dashed-outline copies of other characters.",
  },
  sniper: {
    src: "/brand/anti-sniper.webp",
    width: 1200,
    height: 711,
    alt: "A red character holds up a shield and a dome while blue shapes line up behind it.",
  },
  burn: {
    src: "/brand/buyback-burn.webp",
    width: 1200,
    height: 745,
    alt: "A red character pushes a cart of blue coins along a conveyor into a furnace.",
  },
  reserve: {
    src: "/brand/conviction-reserve.webp",
    width: 1200,
    height: 655,
    alt: "Shape characters carry blue coins into a large glass jar.",
  },
} satisfies Record<string, Art>;

function Section({
  n,
  id,
  title,
  art,
  flip = false,
  children,
}: {
  n: string;
  id: string;
  title: string;
  art?: Art;
  flip?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        "grid scroll-mt-20 items-center gap-6 border-t-2 border-ink py-10 sm:py-14",
        art && "md:grid-cols-2 md:gap-10",
      )}
    >
      {art && (
        <Image
          src={art.src}
          alt={art.alt}
          width={art.width}
          height={art.height}
          sizes="(min-width: 768px) 480px, 100vw"
          className={cn("h-auto w-full", flip && "md:order-2")}
        />
      )}
      <div className="flex min-w-0 flex-col gap-4">
        <p className="num text-sm font-semibold text-accent-strong">{n}</p>
        <h2 id={`${id}-title`} className="display text-[1.75rem] min-[400px]:text-3xl sm:text-4xl">
          {title}
        </h2>
        <div className="flex flex-col gap-3 text-text-muted">{children}</div>
      </div>
    </section>
  );
}

export default async function HowPage() {
  const pairsRes = await getPairSummary().catch(() => null);
  const fee = FEE_CONFIG;
  const r = RESERVE_CONFIG;
  const unverified = fee.status === "unverified" || r.status === "unverified";

  return (
    <PageContainer className="max-w-5xl">
      <header className="pb-8">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-text-subtle">
          How it works
        </p>
        <h1 className="display mt-3 text-[2rem] min-[400px]:text-4xl sm:text-6xl">
          Launch fair.
          <br />
          Build stronger.
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-text-muted">
          What LIFTOFF does on top of StonkFun and Raydium — including its limits.
        </p>
        {unverified && (
          <p className="mt-5 rounded-xl border-2 border-warn/40 bg-warn/5 p-3 text-sm text-text-muted">
            <Tag tone="warn" className="mr-2">
              Not verified yet
            </Tag>
            Conviction Reserve parameters on this page are starting assumptions from the spec and
            still have to be validated by simulation and testing. They may change.
          </p>
        )}
      </header>

      <Section n="01" id="fair-launch" title="Fair token launch." art={ART.fair}>
        <p>
          You pay only the on-chain launch cost, shown before you confirm: your wallet sends it to
          LIFTOFF’s launch authority (the master wallet), which creates the coin. It is refunded
          automatically if the launch fails permanently. There is no dev buy inside the creation
          transaction and no token allocation for the creator.
        </p>
        <p>
          You sign in with your Solana wallet (a signed message, no transaction); your wallet is
          your creator identity. Linking an X account is optional and adds a verified-creator badge.
        </p>
      </Section>

      <Section
        n="02"
        id="master-wallet"
        title="Master launch controller."
        art={ART.controller}
        flip
      >
        <p>
          Every token is created by one LIFTOFF launch authority, using the StonkFun platform config
          on Raydium LaunchLab, with standardized settings. The launch authority is also the token’s
          creator on-chain, so the creator fee goes to LIFTOFF’s fee engine, not to a person.
        </p>
        <p className="text-sm">
          This prevents a creator allocation inside LIFTOFF’s creation workflow. It cannot stop a
          developer from buying later with another wallet.
        </p>
      </Section>

      <Section n="03" id="pair" title="Custom trading pairs." art={ART.pairs}>
        <p>{clusterCopy(getCluster()).howPairs}</p>
        {pairsRes && (
          <div className="flex flex-wrap gap-2">
            <Tag tone="neutral">
              {pairsRes.data.available} of {pairsRes.data.total} open for launch
            </Tag>
            {pairsRes.data.categories
              .filter((c) => c.category !== "all")
              .map((c) => (
                <Tag key={c.category} tone={c.available > 0 ? "neutral" : "warn"}>
                  {c.label} · {c.total}
                </Tag>
              ))}
            {pairsRes.data.unavailable.map((u) => (
              <Tag key={u.symbol} tone="warn">
                {u.symbol} · not on this network
              </Tag>
            ))}
          </div>
        )}
        <p className="text-sm">
          Tokenized assets (SPYx, NVDAx, TSLAx, QQQx) only appear when a config exists for them. On
          graduation, liquidity moves from the bonding curve to a Raydium CPMM pool.
        </p>
      </Section>

      <Section n="04" id="no-vamps" title="Anti-copycat protection." art={ART.copycat} flip>
        <p>Every launch is checked against existing tokens and gets a risk level, with reasons:</p>
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            Name and ticker similarity, after folding case, spaces, homoglyphs and leetspeak (
            <span className="num text-text">$P3PE</span> looks like{" "}
            <span className="num text-text">$PEPE</span>), plus tickers already trading elsewhere.
          </li>
          <li>Near-identical artwork (perceptual image hash).</li>
          <li>An X account, website or Telegram already used by another token.</li>
        </ul>
        <p>
          <span className="font-semibold text-text">Low</span>: nothing significant.{" "}
          <span className="font-semibold text-text">Medium</span>: similar branding exists — the
          launch is allowed and the reasons are shown. A repeated ticker alone is not treated as
          fraud. <span className="font-semibold text-text">High</span>: several signals suggest
          impersonation — the launch is blocked automatically and the creator can submit an appeal,
          which the LIFTOFF owner reviews.
        </p>
        <p className="text-sm">
          Launches are also limited per wallet per day. It reduces copycats; it can’t catch every
          one.
        </p>
      </Section>

      <Section n="05" id="no-block-0" title="Anti-sniper protection." art={ART.sniper}>
        <p>{clusterCopy(getCluster()).howSniperIntro}</p>
        <p className="rounded-xl border-2 border-ink bg-surface p-3 text-text">
          {clusterCopy(getCluster()).howSniperMeaning}
        </p>
      </Section>

      <Section n="06" id="fee" title="Automatic buyback & burn." art={ART.burn} flip>
        <p>
          Each trade on the bonding curve pays a creator fee of{" "}
          <span className="num text-text">{formatBps(fee.creatorFeeBps)}</span> (and{" "}
          <span className="num text-text">{formatBps(fee.expectedCpmmCreatorFeeBps)}</span> on the
          Raydium pool after graduation) to LIFTOFF’s master wallet. LIFTOFF records each token’s
          creator fee from that token’s own trades and allocates it:
          {clusterCopy(getCluster()).feeCaveat && (
            <span className="mt-2 block text-sm">{clusterCopy(getCluster()).feeCaveat}</span>
          )}
        </p>
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            <span className="font-semibold text-burn">Buyback &amp; burn</span>{" "}
            <span className="num text-text">{formatBps(fee.split.buybackBurn)}</span> (≈{" "}
            {formatBps(bpsOf(fee.split.buybackBurn, fee.creatorFeeBps))} of curve trade value): buys
            the token on the open market, then burns it.
          </li>
          <li>
            <span className="font-semibold text-reserve">Conviction Reserve</span>{" "}
            <span className="num text-text">{formatBps(fee.split.convictionReserve)}</span> (≈{" "}
            {formatBps(bpsOf(fee.split.convictionReserve, fee.creatorFeeBps))} of curve trade
            value).
          </li>
        </ul>
        <p className="text-sm">
          Allocation uses integer math; rounding dust goes to buyback &amp; burn, so the two parts
          always add up to exactly the fee received. Buybacks run in batches with slippage limits
          and minimum sizes, and burned supply is counted only from confirmed burn transactions. The{" "}
          <span className="num">{formatBps(fee.platformFeeBps)}</span> platform fee belongs to the
          StonkFun platform config and is not LIFTOFF revenue.
        </p>
      </Section>

      <Card className="mb-4 border-2 border-ink p-4 sm:p-5">
        <FeeSplitDiagram />
      </Card>
      <div className="mb-4">
        <DependencyNotice />
      </div>

      <Section n="07" id="conviction-reserve" title="Conviction reserve." art={ART.reserve}>
        <p>
          The reserve share is accounted separately for each token. After graduation, when the
          liquidity conditions and safety checks pass, part of the reserve can be added to that
          token’s pool — shown only with a link to the proof transaction.
        </p>
        <p className="text-sm">
          Token A’s reserve is never used for token B, and never goes to a LIFTOFF native token. It
          reinforces liquidity; it does not defend a price.{" "}
          <a href="/conviction-reserve" className="underline">
            Conviction Reserve details
          </a>
        </p>
      </Section>

      <div className="grid gap-3 pb-4 sm:grid-cols-2">
        <Card className="p-4 text-sm text-text-muted">
          <p className="mb-2 font-semibold text-text">Thresholds</p>
          <ul className="flex flex-col gap-1.5">
            <li>
              Minimum balance to deploy:{" "}
              <span className="num text-text">{formatUsd(r.minBalanceToDeployUsd, false)}</span>
            </li>
            <li>
              Max per deploy:{" "}
              <span className="num text-text">{formatBps(r.maxDeployPctPerRunBps)}</span> of
              balance, up to{" "}
              <span className="num text-text">{formatUsd(r.maxDeployAbsPerRunUsd, false)}</span>
            </li>
            <li>
              Considered only when pool liquidity is below:{" "}
              <span className="num text-text">
                {formatUsd(r.deployWhenLiquidityBelowUsd, false)}
              </span>
            </li>
            <li>
              Max reserve share of pool:{" "}
              <span className="num text-text">{formatBps(r.maxReserveShareOfPoolBps)}</span>
            </li>
            <li>
              Max slippage / price impact:{" "}
              <span className="num text-text">{formatBps(r.maxSlippageBps)}</span> /{" "}
              <span className="num text-text">{formatBps(r.maxPriceImpactBps)}</span>
            </li>
          </ul>
        </Card>
        <Card className="p-4 text-sm text-text-muted">
          <p className="mb-2 font-semibold text-text">Cooldowns</p>
          <ul className="flex flex-col gap-1.5">
            <li>
              Delay after graduation:{" "}
              <span className="num text-text">
                {formatDuration(r.minTimeSinceGraduationSeconds)}
              </span>
            </li>
            <li>
              Delay between deploys per coin:{" "}
              <span className="num text-text">{formatDuration(r.cooldownSeconds)}</span>
            </li>
            <li>
              Max <span className="num text-text">{r.maxDeploysPerWindow}×</span> per{" "}
              <span className="num text-text">{formatDuration(r.deployWindowSeconds)}</span> per
              coin; max <span className="num text-text">{r.globalMaxDeploysPerDay}</span>{" "}
              deploys/day across the platform
            </li>
            <li>
              Backoff after a failure or extreme market:{" "}
              <span className="num text-text">{formatDuration(r.failureBackoffSeconds)}</span>
            </li>
          </ul>
        </Card>
        <Card className="border-2 border-reserve/40 p-4 text-sm text-text-muted sm:col-span-2">
          <p className="mb-2 font-semibold text-text">Tokens that don’t graduate</p>
          <p>
            The reserve stays in the token’s own custody account, untouched. It is only used after
            the token graduates and its Raydium pool is verified to support adding liquidity. It is
            never redirected to another token or to buyback.
          </p>
        </Card>
      </div>

      <Section n="08" id="fine-print" title="Fine print.">
        <ul className="flex list-disc flex-col gap-2.5 pl-5 text-sm">
          <li>{clusterCopy(getCluster()).howFinePrintIntro}</li>
          <li>
            The creator-fee split is fixed at {formatBps(fee.split.buybackBurn)} /{" "}
            {formatBps(fee.split.convictionReserve)}. Fee rates are read from the chain and from
            config, never written by hand.
          </li>
          <li>
            Creator fees from all tokens accrue in one creator vault per quote asset; LIFTOFF
            attributes them per token from each trade’s on-chain event. Estimated attributions are
            never shown as received funds.
          </li>
          <li>{clusterCopy(getCluster()).howFinePrintBundle}</li>
          <li>
            Buyback &amp; burn and the Conviction Reserve do not guarantee any price. A token’s
            price can go to zero.
          </li>
          <li>Anti-copycat reduces imitation but can’t catch everything.</li>
          <li>
            In the MVP, each token’s reserve sits in its own custody token account controlled by
            LIFTOFF’s signing service, which enforces the rules off-chain. This is weaker than an
            on-chain vault program, which is not built yet.
          </li>
          <li>
            LP lock status is only shown together with a proof transaction link. Without a proof
            link, treat it as unverified.
          </li>
          <li>
            The master wallet is a single point: technically the platform creates every token. This
            carries operational and legal risk that is still under review.
          </li>
          <li>
            LIFTOFF depends on StonkFun and Raydium and is not affiliated with StonkFun, Raydium,
            Jito, or Jupiter.
          </li>
          <li>Not financial advice. Do your own research.</li>
        </ul>
      </Section>

      <div className="flex flex-col gap-3 border-t-2 border-ink pt-10 min-[400px]:flex-row">
        <ButtonLink href="/create" variant="primary" className="px-6 py-3 text-base">
          Launch Token
        </ButtonLink>
        <ButtonLink href="/transparency" className="px-6 py-3 text-base">
          View the ledger
        </ButtonLink>
      </div>
    </PageContainer>
  );
}
