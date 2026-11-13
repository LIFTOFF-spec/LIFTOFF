import { FEE_CONFIG, RESERVE_CONFIG } from "@liftoff/shared";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { DependencyNotice } from "@/components/layout/dependency-notice";
import { Card, PageContainer } from "@/components/ui/primitives";
import { clusterCopy } from "@/lib/cluster";
import { formatBps, formatDuration, formatUsd, getCluster } from "@/lib/format";

export const metadata: Metadata = { title: "FAQ" };

interface Item {
  q: string;
  a: ReactNode;
}

export default function FaqPage() {
  const fee = FEE_CONFIG;
  const r = RESERVE_CONFIG;
  const copy = clusterCopy(getCluster());
  const items: Item[] = [
    {
      q: "What is LIFTOFF?",
      a: "A Solana token launchpad built as an interface and automation layer on StonkFun infrastructure: tokens launch on Raydium LaunchLab and graduate to Raydium CPMM pools. Trading-generated creator fees fund buyback & burn and each token’s Conviction Reserve.",
    },
    {
      q: "What does it cost to launch?",
      a: "Only the on-chain launch cost (the accounts for the mint, pool and vaults). The exact amount in SOL is shown on the review step before you confirm. You pay it from your wallet to LIFTOFF’s launch authority (the master wallet), which then creates the coin. It is kept if the coin goes live and refunded automatically if the launch fails permanently. There is no other launch fee and no token allocation for anyone.",
    },
    {
      q: "Where do the fees go?",
      a: (
        <>
          Each bonding-curve trade pays a creator fee of {formatBps(fee.creatorFeeBps)} (
          {formatBps(fee.expectedCpmmCreatorFeeBps)} on the Raydium pool after graduation) to
          LIFTOFF’s master wallet. LIFTOFF allocates each token’s creator fees{" "}
          {formatBps(fee.split.buybackBurn)} to buyback &amp; burn and{" "}
          {formatBps(fee.split.convictionReserve)} to that token’s Conviction Reserve. There is no
          treasury share. The {formatBps(fee.platformFeeBps)} platform fee belongs to the StonkFun
          platform config and is not LIFTOFF revenue; Raydium also charges its protocol fee.
          {copy.feeCaveat && ` ${copy.feeCaveat}`}
        </>
      ),
    },
    {
      q: "Is StonkFun live here?",
      a: copy.faqStonkfun,
    },
    {
      q: "Which trading pairs are supported?",
      a: copy.faqPairs,
    },
    {
      q: "Can the developer still dump on buyers?",
      a: "LIFTOFF’s creation transaction contains no creator purchase and gives the creator no allocation. It cannot stop someone from buying later with another wallet, so LIFTOFF never claims that developer selling is impossible.",
    },
    {
      q: "Is LIFTOFF sniper-proof?",
      a: copy.faqSniper,
    },
    {
      q: "Why was my launch flagged?",
      a: "The anti-copycat check compares your name, ticker, image, X account, website and Telegram with existing tokens. Medium risk (similar branding, or a repeated ticker) is allowed and the reasons are shown. High risk (several signals of impersonation) is blocked automatically; you can appeal from the create form, and the LIFTOFF owner reviews it.",
    },
    {
      q: "When does the Conviction Reserve deploy?",
      a: (
        <>
          Only after graduation, once the pool is verified compatible, the reserve holds at least{" "}
          {formatUsd(r.minBalanceToDeployUsd, false)}, liquidity is below the threshold, all safety
          checks pass, and the {formatDuration(r.cooldownSeconds)} cooldown has passed — at most{" "}
          {formatBps(r.maxDeployPctPerRunBps)} of the reserve per cycle. It reinforces liquidity; it
          does not guarantee any price. Each deployment burns its LP tokens in the same transaction.{" "}
          <Link href="/conviction-reserve" className="underline">
            Details
          </Link>
        </>
      ),
    },
    {
      q: "Is the liquidity locked permanently?",
      a: "Only when a lock is enforced on-chain, and then shown with a proof transaction. Until then, LIFTOFF does not claim a permanent lock.",
    },
    {
      q: "How can I verify the numbers?",
      a: (
        <>
          Every creator fee, allocation, burn and deployment is recorded in an append-only ledger
          with its transaction signature. Figures read from confirmed transactions are marked
          verified; estimates and sample data are marked as such.{" "}
          <Link href="/transparency" className="underline">
            Transparency
          </Link>
        </>
      ),
    },
    {
      q: "Is there a LIFTOFF token?",
      a: "Not yet. If one launches, it will use the same standardized launch and will never receive reserve funds that belong to other tokens.",
    },
  ];

  return (
    <PageContainer className="flex max-w-3xl flex-col gap-8">
      <header>
        <h1 className="display text-[2rem] min-[400px]:text-4xl sm:text-5xl">FAQ.</h1>
        <p className="mt-3 text-text-muted">Short answers, including the limits.</p>
      </header>
      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <Card key={item.q} className="p-0">
            <details className="group p-4">
              <summary className="cursor-pointer list-none font-semibold marker:hidden">
                <span className="mr-2 inline-block transition group-open:rotate-90">›</span>
                {item.q}
              </summary>
              <div className="mt-2 text-sm text-text-muted">{item.a}</div>
            </details>
          </Card>
        ))}
      </div>
      <DependencyNotice compact />
      <p className="text-xs text-text-subtle">Not financial advice. Token prices can go to zero.</p>
    </PageContainer>
  );
}
