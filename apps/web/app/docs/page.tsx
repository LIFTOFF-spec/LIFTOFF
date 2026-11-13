import { FEE_CONFIG } from "@liftoff/shared";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { DependencyNotice } from "@/components/layout/dependency-notice";
import { STATUS_DEFINITIONS, StatusBadge } from "@/components/ui/badges";
import { Card, PageContainer } from "@/components/ui/primitives";
import { getLaunchRules, getPairSummary, getStonkFunInfo } from "@/lib/api";
import { clusterCopy } from "@/lib/cluster";
import { explorerUrl, formatBps, getCluster, shortAddress } from "@/lib/format";

export const metadata: Metadata = { title: "Docs" };

const SECTIONS = [
  { id: "overview", title: "Overview" },
  { id: "getting-started", title: "Getting started" },
  { id: "launch", title: "Launch a token" },
  { id: "trade", title: "Trade" },
  { id: "graduation", title: "Graduation" },
  { id: "fees", title: "Fees & allocation" },
  { id: "reserve", title: "Conviction Reserve" },
  { id: "anti-copycat", title: "Anti-copycat & appeals" },
  { id: "data", title: "Reading the numbers" },
  { id: "verify", title: "Verify on-chain" },
  { id: "risks", title: "Risks & limits" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const title = SECTIONS.find((s) => s.id === id)?.title;
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-24 border-t-2 border-ink pt-8"
    >
      <h2 id={`${id}-title`} className="display text-2xl sm:text-3xl">
        {title}
      </h2>
      <div className="mt-4 flex flex-col gap-3 text-text-muted [&_a]:underline [&_a]:decoration-line-strong [&_a]:underline-offset-2 [&_li]:pl-1 [&_strong]:text-text">
        {children}
      </div>
    </section>
  );
}

function Address({ label, address }: { label: string; address: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 text-sm">
      <dt className="text-text-muted">{label}</dt>
      <dd>
        <a
          href={explorerUrl("address", address)}
          target="_blank"
          rel="noreferrer"
          className="num break-all text-text underline decoration-line-strong underline-offset-2"
          title={address}
        >
          {shortAddress(address, 6)} ↗
        </a>
      </dd>
    </div>
  );
}

export default async function DocsPage() {
  const [rulesRes, pairsRes, stonkfunRes] = await Promise.all([
    getLaunchRules().catch(() => null),
    getPairSummary().catch(() => null),
    getStonkFunInfo().catch(() => null),
  ]);
  const rules = rulesRes ?? null;
  const pairs = pairsRes?.data ?? null;
  const stonkfun = stonkfunRes?.data ?? null;
  const fee = FEE_CONFIG;
  const copy = clusterCopy(getCluster());
  const platformFeeBps = stonkfun?.platformFeeBps ?? fee.platformFeeBps;

  return (
    <PageContainer className="max-w-6xl">
      <header className="pb-8">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-text-subtle">Docs</p>
        <h1 className="display mt-3 text-[2rem] min-[400px]:text-4xl sm:text-5xl">LIFTOFF docs.</h1>
        <p className="mt-3 max-w-2xl text-lg text-text-muted">
          How to launch and trade, where the fees go, and how to check every number yourself.
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-12">
        <nav aria-label="Docs sections" className="lg:sticky lg:top-24 lg:self-start">
          <Card className="p-4 lg:border-0 lg:bg-transparent lg:p-0">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
              On this page
            </p>
            <ol className="grid grid-cols-1 gap-1.5 text-sm min-[420px]:grid-cols-2 lg:grid-cols-1">
              {SECTIONS.map((s, i) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className="text-text-muted hover:text-text">
                    <span className="num mr-1.5 text-text-subtle">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {s.title}
                  </a>
                </li>
              ))}
            </ol>
          </Card>
        </nav>

        <div className="flex min-w-0 max-w-3xl flex-col gap-10">
          <Section id="overview">
            <p>
              LIFTOFF is a Solana token launchpad. It is an interface and automation layer on top of
              StonkFun and Raydium: tokens launch on a Raydium LaunchLab bonding curve with
              StonkFun’s platform config, and move to a Raydium CPMM pool when the curve completes.
            </p>
            <p>
              Trading-generated creator fees fund two things for each token:{" "}
              <strong>{formatBps(fee.split.buybackBurn)} buyback &amp; burn</strong> and{" "}
              <strong>{formatBps(fee.split.convictionReserve)} Conviction Reserve</strong>. There is
              no treasury share and no token allocation for anyone.
            </p>
            <p className="text-sm">{copy.howFinePrintIntro}</p>
          </Section>

          <Section id="getting-started">
            <ol className="flex list-decimal flex-col gap-2 pl-5">
              <li>
                Install a Solana wallet such as Phantom or Solflare and fund it with SOL. Use a
                wallet you control; LIFTOFF never asks for your seed phrase.
              </li>
              <li>
                Click <strong>Connect wallet</strong>. To launch, you also sign a short message to
                sign in. Signing in is not a transaction and costs nothing.
              </li>
              <li>
                Linking an X account is optional and adds a verified-creator badge to your tokens.
              </li>
            </ol>
            <p className="text-sm">
              Every transaction is signed in your own wallet, and you see what you sign before you
              approve it.
            </p>
          </Section>

          <Section id="launch">
            <p>
              Go to <Link href="/create">Create</Link>. A launch has three steps:
            </p>
            <ol className="flex list-decimal flex-col gap-2 pl-5">
              <li>
                <strong>Coin details</strong>: name, ticker, image, and optional description,
                website, Telegram and X account. The anti-copycat check runs as you type.
              </li>
              <li>
                <strong>Pick a pair</strong>: the asset your token trades against. {copy.faqPairs}
              </li>
              <li>
                <strong>Review &amp; launch</strong>: check everything, pay the launch cost from
                your wallet, and LIFTOFF creates the token.
              </li>
            </ol>
            {rules && (
              <Card className="p-4 text-sm">
                <p className="mb-2 font-semibold text-text">Current launch rules</p>
                <ul className="flex list-disc flex-col gap-1.5 pl-5">
                  {rules.deposit.enabled && (
                    <li>
                      Launch cost: <span className="num text-text">{rules.deposit.sol} SOL</span>,
                      refunded automatically only if the launch fails permanently.
                    </li>
                  )}
                  <li>
                    Wallet balance needed:{" "}
                    <span className="num text-text">{rules.minBalanceSol} SOL</span> or more.
                  </li>
                  <li>
                    <span className="num text-text">{rules.perWalletPer24h}</span> launch per wallet
                    per 24 hours; <span className="num text-text">{rules.globalPerDay}</span>{" "}
                    launches per day across LIFTOFF.
                  </li>
                </ul>
              </Card>
            )}
            <p>
              After you confirm, the launch page shows each step until the token is live. The
              creation transaction contains no creator purchase. {copy.createSniper}
            </p>
            <p className="text-sm">
              Every token is created by LIFTOFF’s launch authority (the master wallet), which is
              also the token’s creator on-chain. Your wallet is recorded as the creator on LIFTOFF.
            </p>
          </Section>

          <Section id="trade">
            <p>
              Open any token from <Link href="/explore">Explore</Link> and use the Trading panel.
              Choose Buy or Sell, enter an amount, and set a maximum slippage. Before you sign you
              see the estimated amount you receive, the minimum after slippage, the price impact,
              and the fees read on-chain.
            </p>
            <ul className="flex list-disc flex-col gap-2 pl-5">
              <li>
                Before graduation, trades go through the token’s Raydium LaunchLab bonding curve.
                The price rises as tokens are bought and falls as they are sold.
              </li>
              <li>After graduation, trades go through the token’s Raydium CPMM pool.</li>
              <li>
                The transaction is simulated before you sign. If the price moves beyond your
                slippage limit, the trade fails instead of filling at a worse price.
              </li>
            </ul>
            <p className="text-sm">
              Tokens can also be traded outside LIFTOFF. Those trades still count in LIFTOFF’s
              market data, because LIFTOFF reads them on-chain.
            </p>
          </Section>

          <Section id="graduation">
            <p>
              Each bonding curve has a target raise in its pair asset. When the curve sells out, the
              token graduates: liquidity moves from the curve to a Raydium CPMM pool. The token page
              shows the progress and how much is left.
            </p>
            {pairs && (
              <p className="text-sm">
                {pairs.available} of {pairs.total} StonkFun pairs are open for launch right now.
              </p>
            )}
            <p className="text-sm">
              LP lock status is shown only together with a proof transaction. Without a proof link,
              treat it as unverified.
            </p>
          </Section>

          <Section id="fees">
            <p>
              Each trade pays a platform fee of{" "}
              <span className="num text-text">{formatBps(platformFeeBps)}</span>, which belongs to
              the StonkFun platform config and is not LIFTOFF revenue. The creator fee (
              <span className="num text-text">{formatBps(fee.creatorFeeBps)}</span> on the curve,{" "}
              <span className="num text-text">{formatBps(fee.expectedCpmmCreatorFeeBps)}</span> on
              the Raydium pool) goes to LIFTOFF’s master wallet. Raydium also charges its protocol
              fee.
            </p>
            <p>
              LIFTOFF allocates each token’s creator fees{" "}
              <strong>{formatBps(fee.split.buybackBurn)}</strong> to buying back that same token and
              burning it, and <strong>{formatBps(fee.split.convictionReserve)}</strong> to that
              token’s Conviction Reserve. Rounding dust goes to buyback &amp; burn, so both parts
              always add up to the fee received.
            </p>
            <p className="text-sm">{copy.feeIntakeIntro}</p>
            {copy.feeCaveat && <p className="text-sm">{copy.feeCaveat}</p>}
          </Section>

          <Section id="reserve">
            <p>
              The reserve share is kept separately for each token. After graduation, when liquidity
              is thin and every safety check passes, part of it can be added to that token’s own
              pool, and the LP tokens are burned in the same transaction. A token’s reserve is never
              used for another token.
            </p>
            <p className="text-sm">
              It reinforces liquidity; it does not defend a price.{" "}
              <Link href="/conviction-reserve">Thresholds, cooldowns and current balances</Link>
            </p>
          </Section>

          <Section id="anti-copycat">
            <p>
              Every launch is compared with existing tokens: name and ticker (including look-alike
              letters), image, X account, website and Telegram. You see the risk level and the
              reasons before you pay.
            </p>
            <ul className="flex list-disc flex-col gap-2 pl-5">
              <li>
                <strong>Low</strong>: nothing significant.
              </li>
              <li>
                <strong>Medium</strong>: similar branding exists. The launch is allowed and the
                reasons are shown. A repeated ticker alone is not treated as fraud.
              </li>
              <li>
                <strong>High</strong>: several signals suggest impersonation. The launch is blocked;
                you can submit an appeal from the create form for the LIFTOFF owner to review.
              </li>
            </ul>
            <p className="text-sm">
              It reduces copycats but cannot catch every one.{" "}
              <Link href="/how#no-vamps">More on anti-copycat</Link>
            </p>
          </Section>

          <Section id="data">
            <p>Every number on LIFTOFF carries a status:</p>
            <dl className="flex flex-col gap-2">
              {(Object.keys(STATUS_DEFINITIONS) as Array<keyof typeof STATUS_DEFINITIONS>).map(
                (status) => (
                  <div key={status} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <dt className="w-24 shrink-0">
                      <StatusBadge status={status} />
                    </dt>
                    <dd className="min-w-0 flex-1 text-sm">{STATUS_DEFINITIONS[status]}</dd>
                  </div>
                ),
              )}
            </dl>
            <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
              <li>
                <strong>USD figures</strong> are estimates: on-chain amounts in the pair asset,
                converted at its current price (StonkFun, cross-checked with Jupiter). They show n/a
                while that price cannot be verified.
              </li>
              <li>
                <strong>Market cap</strong> = price × on-chain supply. Burned tokens are already
                removed from the supply.
              </li>
              <li>
                <strong>Small prices</strong> are shortened: $0.0₅2592 means five zeros after the
                decimal point, $0.000002592.
              </li>
              <li>
                <strong>The chart</strong> builds candles from on-chain trades, in UTC. Its USD and
                market cap history uses today’s pair price and today’s supply, so older candles are
                estimates. Periods without trades have no candle.
              </li>
            </ul>
          </Section>

          <Section id="verify">
            <p>
              You do not have to trust these pages. Every fee, allocation, buyback, burn and reserve
              deployment is recorded in an append-only ledger with its transaction signature, on the{" "}
              <Link href="/transparency">Transparency</Link> page and on each token’s page.
              Corrections are added as new entries, never edited.
            </p>
            {(rules || stonkfun) && (
              <Card className="px-4 py-2">
                <dl className="divide-y divide-line">
                  {rules?.deposit.recipient && (
                    <Address label="LIFTOFF master wallet" address={rules.deposit.recipient} />
                  )}
                  {stonkfun && (
                    <>
                      <Address label="StonkFun platform config" address={stonkfun.platformId} />
                      <Address
                        label="Raydium LaunchLab program"
                        address={stonkfun.launchlabProgram}
                      />
                    </>
                  )}
                </dl>
              </Card>
            )}
          </Section>

          <Section id="risks">
            <ul className="flex list-disc flex-col gap-2 pl-5">
              <li>Launches and trades use real funds and cannot be undone.</li>
              <li>
                Token prices can go to zero. Buyback &amp; burn and the reserve guarantee nothing.
              </li>
              <li>{copy.howSniperMeaning}</li>
              <li>
                LIFTOFF depends on StonkFun and Raydium and is not affiliated with StonkFun,
                Raydium, Jito or Jupiter.
              </li>
              <li>Not financial advice. Do your own research.</li>
            </ul>
            <p className="text-sm">
              <Link href="/how#fine-print">Full fine print</Link> · <Link href="/faq">FAQ</Link>
            </p>
            <DependencyNotice compact />
          </Section>
        </div>
      </div>
    </PageContainer>
  );
}
