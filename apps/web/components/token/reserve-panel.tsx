import { RESERVE_CONFIG } from "@liftoff/shared";
import type { ReserveLedgerEntry, ReserveMode, ReserveState } from "@liftoff/shared";
import {
  explorerUrl,
  formatBps,
  formatDuration,
  formatNumber,
  formatUsd,
  shortAddress,
} from "@/lib/format";
import { MockBadge, Tag } from "../ui/badges";
import { Card, cn } from "../ui/primitives";
import { StatCard } from "../ui/stat-card";
import { Countdown, RelativeTime } from "../ui/time";
import { ReserveDeploymentList } from "./reserve-deployments";
import { TransactionHistory } from "./transaction-history";

const MODE_LABEL: Record<
  ReserveMode,
  { label: string; tone: "reserve" | "success"; desc: string }
> = {
  accumulating: {
    label: "Accumulating",
    tone: "reserve",
    desc: "The reserve is collected and held untouched until the token graduates and its Raydium pool is verified. It is never spent before that.",
  },
  deploying_liquidity: {
    label: "Deploying liquidity",
    tone: "success",
    desc: "The token has graduated and its pool is verified. Part of the reserve can be added to this token’s CPMM pool when every rule and safety check passes.",
  },
};

const STEPS: Array<{ mode: ReserveMode; label: string }> = [
  { mode: "accumulating", label: "Accumulating" },
  { mode: "deploying_liquidity", label: "Graduated → liquidity" },
];

const ENTRY_LABEL: Record<ReserveLedgerEntry["entryType"], string> = {
  contribution: "Contribution",
  deployment: "Deployment",
  correction: "Correction",
};

function ParamRow({
  label,
  value,
  overridden,
}: {
  label: string;
  value: string;
  overridden?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt className="text-text-muted">{label}</dt>
      <dd className="num flex items-center gap-1.5 text-right">
        {value}
        {overridden && <Tag tone="warn">Override</Tag>}
      </dd>
    </div>
  );
}

function AddressLink({ address }: { address: string }) {
  return (
    <a
      href={explorerUrl("address", address)}
      target="_blank"
      rel="noreferrer"
      className="num text-xs underline decoration-line-strong underline-offset-2"
    >
      {shortAddress(address, 5)} ↗
    </a>
  );
}

const bpsText = (bps: number | null) => (bps === null ? "n/a" : `${(bps / 100).toFixed(2)}%`);

/** Dashboard Conviction Reserve per token (Spec §16 Section 3, §11 Phase 2 & 5). */
export function ReservePanel({
  state,
  entries,
  ticker,
  graduated,
}: {
  state: ReserveState;
  entries: ReserveLedgerEntry[];
  ticker: string;
  graduated: boolean;
}) {
  const isMock = state.balance.source === "mock";
  const mode = MODE_LABEL[state.mode];
  const p = state.params;
  const ov = (key: string) => p.overridden.includes(key);
  const d = state.latestDecision;
  const custody = state.custody;

  return (
    <div className="flex flex-col gap-6">
      {/* status & mode */}
      <Card className="flex flex-col gap-4 border-2 border-ink p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-text-muted">Reserve mode</span>
          <Tag tone={mode.tone}>{mode.label}</Tag>
          {state.paused && <Tag tone="danger">Paused</Tag>}
          {isMock && <MockBadge className="ml-auto" />}
        </div>
        <p className="text-sm text-text-muted">{mode.desc}</p>

        <ol className="grid grid-cols-2 gap-2 text-[11px]" aria-label="Reserve state">
          {STEPS.map((s) => (
            <li
              key={s.mode}
              aria-current={s.mode === state.mode ? "step" : undefined}
              className={cn(
                "rounded-lg border-2 px-2.5 py-2",
                s.mode === state.mode
                  ? "border-reserve bg-reserve/10 font-semibold text-text"
                  : "border-line text-text-subtle",
              )}
            >
              {s.label}
            </li>
          ))}
        </ol>

        {state.mode === "deploying_liquidity" && (
          <div className="rounded-xl border border-line bg-bg p-3.5">
            <p className="text-xs text-text-muted">Cooldown status</p>
            {state.nextActionEarliestAt ? (
              <p className="mt-1 text-sm">
                Next deployment at the earliest in{" "}
                <Countdown
                  iso={state.nextActionEarliestAt}
                  doneLabel="now (if every check passes)"
                  className="num font-semibold"
                />
              </p>
            ) : (
              <p className="mt-1 text-sm">No active cooldown.</p>
            )}
            <p className="mt-1.5 text-[11px] text-text-subtle">
              {state.lastDeployAt ? (
                <>
                  Last deployment <RelativeTime iso={state.lastDeployAt} />.{" "}
                </>
              ) : null}
              Deployments in this window: {state.deploysInWindow}/{p.maxDeploysPerWindow} per{" "}
              {formatDuration(p.deployWindowSeconds)}.
            </p>
          </div>
        )}

        {state.holdReasons.length > 0 && (
          <div>
            <p className="text-xs text-text-muted">Reasons it’s on hold (latest evaluation)</p>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-sm text-text-muted">
              {state.holdReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* saldo (Spec §16 Section 3) */}
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 2xl:grid-cols-4">
        <StatCard
          label="Current reserve balance"
          stat={state.balance}
          definition={`$${ticker} reserve from creator fees the master wallet has already claimed, minus what was deployed, in pair units. It can only be added to this token’s own pool liquidity.`}
          footer={
            state.balanceUsd.value !== null && (
              <span className="num text-xs text-text-subtle">
                ≈ {formatUsd(state.balanceUsd.value)}
              </span>
            )
          }
        />
        <StatCard
          label="Lifetime contributions"
          stat={state.totalContributed}
          definition="Lifetime 20% reserve share recorded from this token’s trades, including fees not claimed yet."
          footer={
            Number(state.awaitingClaim.value ?? 0) > 0 && (
              <span className="num text-xs text-text-subtle">
                {state.awaitingClaim.value} {state.awaitingClaim.unit} not yet claimed
              </span>
            )
          }
        />
        <StatCard
          label="Total liquidity deployed"
          stat={state.totalDeployed}
          definition="Reserve that left this token’s custody account and was added to its CPMM pool, measured from the confirmed transactions."
        />
        {custody && (
          <StatCard
            label="Held in custody"
            stat={custody.inCustody}
            definition="Reserve already moved to this token’s own custody account and available for the next deployment."
            footer={
              Number(custody.inMasterAccount.value ?? 0) > 0 && (
                <span className="num text-xs text-text-subtle">
                  {custody.inMasterAccount.value} {custody.inMasterAccount.unit} waiting to be moved
                </span>
              )
            }
          />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* kustodi */}
        {custody && (
          <Card className="p-4 sm:p-5">
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              Reserve custody <Tag tone="warn">MVP: segregated account</Tag>
            </h3>
            <dl className="mt-3 divide-y divide-line text-sm">
              <div className="flex items-center justify-between gap-3 py-2">
                <dt className="text-text-muted">Quote custody account</dt>
                <dd>
                  <AddressLink address={custody.quoteAccount} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-2">
                <dt className="text-text-muted">Token custody account</dt>
                <dd>
                  <AddressLink address={custody.tokenAccount} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-2">
                <dt className="text-text-muted">Unused ${ticker} from swaps</dt>
                <dd className="num">{formatNumber(custody.tokenResidual.value ?? "0", 2)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-text-subtle">{custody.trustNote}</p>
          </Card>
        )}

        {/* liquidity monitoring (Spec §11 Phase 2) */}
        <Card className="p-4 sm:p-5">
          <h3 className="text-sm font-semibold">Liquidity monitoring</h3>
          {d ? (
            <>
              <p className="mt-1 text-xs text-text-subtle">
                Last checked <RelativeTime iso={d.at} /> ·{" "}
                {d.allowed ? "deployment allowed" : "on hold"}
              </p>
              <dl className="mt-3 divide-y divide-line text-sm">
                <ParamRow
                  label="Pool liquidity (quote side)"
                  value={`${formatNumber(d.poolLiquidity.value ?? "0", 4)} ${d.poolLiquidity.unit} ≈ ${d.poolLiquidityUsd.value === null ? "n/a" : formatUsd(Number(d.poolLiquidityUsd.value))}`}
                />
                <ParamRow
                  label="Depth for a +2% price move"
                  value={`${formatNumber(d.depth2Pct.value ?? "0", 6)} ${d.depth2Pct.unit}`}
                />
                <ParamRow label="Estimated price impact" value={bpsText(d.priceImpactBps)} />
                <ParamRow label="Volume change (24h)" value={bpsText(d.volumeChangeBps)} />
                <ParamRow label="1h price / liquidity move" value={bpsText(d.oneHourMoveBps)} />
              </dl>
            </>
          ) : (
            <p className="mt-2 text-sm text-text-muted">
              {graduated
                ? "Monitoring starts once the migrated pool is verified."
                : "Monitoring starts after graduation (Spec §14)."}
            </p>
          )}
        </Card>

        {/* threshold */}
        <Card className="p-4 sm:p-5">
          <h3 className="text-sm font-semibold">Active thresholds & cooldowns</h3>
          <p className="mt-1 text-xs text-text-subtle">
            From RESERVE_CONFIG{p.overridden.length > 0 ? " + this token’s overrides" : ""} ·{" "}
            {RESERVE_CONFIG.status === "unverified" ? "starting assumptions" : "verified"}
          </p>
          <dl className="mt-3 divide-y divide-line text-sm">
            <ParamRow
              label="Minimum balance to deploy"
              value={formatUsd(p.minBalanceToDeployUsd, false)}
            />
            <ParamRow
              label="Max per deploy"
              value={`${formatBps(p.maxDeployPctPerRunBps)} of balance · ${formatUsd(p.maxDeployAbsPerRunUsd, false)}`}
              overridden={ov("maxDeployPctPerRunBps")}
            />
            <ParamRow
              label="Max reserve share of pool"
              value={formatBps(p.maxReserveShareOfPoolBps)}
            />
            <ParamRow
              label="Delay after graduation"
              value={formatDuration(p.minTimeSinceGraduationSeconds)}
            />
            <ParamRow
              label="Cooldown between deploys"
              value={formatDuration(p.cooldownSeconds)}
              overridden={ov("cooldownSeconds")}
            />
            <ParamRow
              label="Max deploys per window"
              value={`${p.maxDeploysPerWindow}× / ${formatDuration(p.deployWindowSeconds)}`}
            />
          </dl>
        </Card>

        {/* pool & LP */}
        <Card className="p-4 sm:p-5">
          <h3 className="text-sm font-semibold">Pool & LP</h3>
          <dl className="mt-3 divide-y divide-line text-sm">
            <div className="flex items-center justify-between gap-3 py-2">
              <dt className="text-text-muted">CPMM pool</dt>
              <dd>
                {state.poolAddress ? (
                  <AddressLink address={state.poolAddress} />
                ) : (
                  <span className="text-text-subtle">None yet (not graduated)</span>
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-2">
              <dt className="text-text-muted">Liquidity lock status</dt>
              <dd className="text-right">
                {state.lpLock.status === "locked" && state.lpLock.proofSignature ? (
                  <span className="flex flex-col items-end gap-1">
                    <Tag tone="success">LP burned (non-withdrawable)</Tag>
                    <a
                      href={explorerUrl("tx", state.lpLock.proofSignature)}
                      target="_blank"
                      rel="noreferrer"
                      className="num text-xs text-text-muted underline decoration-line-strong underline-offset-2"
                    >
                      Proof {shortAddress(state.lpLock.proofSignature, 5)} ↗
                    </a>
                  </span>
                ) : state.lpLock.status === "unverified" ? (
                  <Tag tone="warn">Not verified</Tag>
                ) : state.lpLock.status === "pending" ? (
                  <Tag tone="warn">No deploys yet</Tag>
                ) : (
                  <span className="text-text-subtle">n/a</span>
                )}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-text-subtle">
            Every reserve deployment burns the LP tokens it receives in the same transaction, so
            nobody (LIFTOFF included) can withdraw that liquidity. The lock is shown only when the
            burn is proven from the on-chain transaction.
          </p>
          <p className="mt-3 text-xs text-text-subtle">
            The ${ticker} reserve stands alone: it is never used for other tokens, never lent out,
            and never sent to a LIFTOFF native token. It reinforces liquidity; it does not defend a
            price.
          </p>
        </Card>
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold">Deployments</h3>
        <ReserveDeploymentList deployments={state.deployments} showToken={false} />
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold">Reserve history</h3>
        <TransactionHistory
          caption={`${ticker} reserve history`}
          isMock={isMock}
          emptyTitle="No reserve activity yet"
          rows={entries.map((e) => ({
            key: e.id,
            type: (
              <Tag tone={e.entryType === "deployment" ? "success" : "reserve"}>
                {ENTRY_LABEL[e.entryType]}
              </Tag>
            ),
            detail:
              e.entryType === "contribution"
                ? "Fee share added to reserve"
                : e.entryType === "deployment"
                  ? "Add liquidity to CPMM pool + burn LP"
                  : "Correction",
            amount: `${formatNumber(e.amount, 9)} ${e.assetSymbol}`,
            signature: e.txSignature,
            createdAt: e.createdAt,
          }))}
        />
      </div>
    </div>
  );
}
