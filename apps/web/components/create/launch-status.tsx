"use client";

import type { LaunchJob, LaunchStatus } from "@liftoff/shared";
import Image from "next/image";
import { useEffect, useState } from "react";
import { Tag } from "@/components/ui/badges";
import { ButtonLink, Card, cn } from "@/components/ui/primitives";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/states";
import { RelativeTime } from "@/components/ui/time";
import { getLaunch } from "@/lib/api";
import { clusterCopy } from "@/lib/cluster";
import { explorerUrl, getCluster, shortAddress } from "@/lib/format";
import { formatUnits } from "@/lib/units";

const FLOW: LaunchStatus[] = ["validating", "queued", "submitting", "confirming", "live"];

const LABELS: Record<LaunchStatus, string> = {
  validating: "Validating",
  queued: "Queued",
  submitting: "Submitting",
  confirming: "Confirming",
  live: "Live",
  failed: "Failed",
  needs_reconciliation: "Needs reconciliation",
};

const SEND_PATH = clusterCopy(getCluster()).launchSendPath;

const DESCRIPTIONS: Record<LaunchStatus, string> = {
  validating: "Re-checking the ticker, image, wallet limits, and linked X account (if any).",
  queued: "The job is in the launch queue.",
  submitting: `The transaction is simulated and signed by the master wallet, then ${SEND_PATH}.`,
  confirming: "Waiting for the transaction to land and for the mint + pool to verify on-chain.",
  live: "The token is live. The mint address is published.",
  failed: "The launch failed permanently. The ticker claim was released.",
  needs_reconciliation:
    "Status is uncertain. The system checks the signature and the chain before anything is resent — no double launches.",
};

const FINAL: LaunchStatus[] = ["live", "failed", "needs_reconciliation"];

/** Animasi brand (video Asset/, di-encode ulang) selama launch masih berjalan. */
function LaunchLoop() {
  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border-2 border-ink bg-bg">
      <video
        className="block aspect-[478/270] w-full motion-reduce:hidden"
        src="/brand/launch-loop.mp4"
        poster="/brand/launch-loop-poster.webp"
        autoPlay
        loop
        muted
        playsInline
        aria-hidden
      />
      <Image
        src="/brand/launch-loop-poster.webp"
        alt=""
        width={478}
        height={270}
        className="hidden w-full motion-reduce:block"
      />
    </div>
  );
}

export function LaunchStatusView({ id }: { id: string }) {
  const [job, setJob] = useState<LaunchJob | null | undefined>(undefined);

  // polling GET /api/launch/:id sampai status final
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let res: LaunchJob | null;
      try {
        res = await getLaunch(id);
      } catch {
        if (!cancelled) timer = setTimeout(poll, 5_000);
        return;
      }
      if (cancelled) return;
      setJob(res);
      if (res && !FINAL.includes(res.status)) timer = setTimeout(poll, 3_000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id]);

  if (job === undefined) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }
  if (job === null) {
    return (
      <EmptyState
        title="Launch job not found"
        description="Check the link, or start a new launch."
        action={<ButtonLink href="/create">Create a coin</ButtonLink>}
      />
    );
  }

  const reached = new Map(job.timeline.map((t) => [t.status, t.at]));
  const terminalError = job.status === "failed" || job.status === "needs_reconciliation";
  const steps: LaunchStatus[] = terminalError
    ? [...FLOW.filter((s) => reached.has(s)), job.status]
    : FLOW;

  return (
    <div className="flex flex-col gap-5">
      <Card className="flex flex-col gap-3 border-2 border-ink p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="display text-3xl">${job.token.ticker}</h1>
          <Tag>/{job.token.quoteSymbol}</Tag>
          <Tag
            tone={
              job.status === "live"
                ? "success"
                : job.status === "failed"
                  ? "danger"
                  : job.status === "needs_reconciliation"
                    ? "warn"
                    : "neutral"
            }
          >
            {LABELS[job.status]}
          </Tag>
        </div>
        <dl className="grid gap-2 text-xs text-text-muted sm:grid-cols-3">
          <div>
            <dt className="text-text-subtle">Job</dt>
            <dd className="num truncate">{job.id}</dd>
          </div>
          <div>
            <dt className="text-text-subtle">Idempotency key</dt>
            <dd className="num truncate">{job.idempotencyKey}</dd>
          </div>
          <div>
            <dt className="text-text-subtle">Attempts</dt>
            <dd className="num">{job.attemptCount}</dd>
          </div>
        </dl>
      </Card>

      {!FINAL.includes(job.status) && <LaunchLoop />}

      {!FINAL.includes(job.status) && (
        <p
          role="status"
          className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-xs text-text-muted"
        >
          {job.status === "queued" && job.lastError
            ? job.lastError
            : job.deposit
              ? "Your ticker (and linked X account, if any) is reserved and your launch-cost payment was received. The LIFTOFF master wallet now creates the coin. This page updates automatically."
              : "Your ticker (and linked X account, if any) is reserved. You pay nothing: the LIFTOFF master wallet creates and pays for the coin. This page updates automatically."}
        </p>
      )}

      {job.deposit && <DepositNote deposit={job.deposit} />}

      <Card className="p-4 sm:p-5">
        <ol className="flex flex-col" aria-label="Launch status">
          {steps.map((s, i) => {
            const at = reached.get(s);
            const current = s === job.status;
            const done = Boolean(at) && !current;
            const bad = current && terminalError;
            return (
              <li
                key={s}
                aria-current={current ? "step" : undefined}
                className="relative flex gap-3 pb-5 last:pb-0"
              >
                {i < steps.length - 1 && (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute top-5 left-[9px] h-[calc(100%-1.25rem)] w-px",
                      done ? "bg-ink" : "bg-line",
                    )}
                  />
                )}
                <span
                  aria-hidden
                  className={cn(
                    "relative mt-0.5 flex size-[19px] shrink-0 items-center justify-center rounded-full border-2 text-[10px] font-bold",
                    bad
                      ? "border-danger bg-danger/20 text-danger"
                      : current && s === "live"
                        ? "border-ink bg-success text-white"
                        : current
                          ? "border-ink bg-surface text-ink"
                          : done
                            ? "border-ink bg-ink text-bg"
                            : "border-line-strong text-text-subtle",
                  )}
                >
                  {bad ? (
                    "!"
                  ) : done || (current && s === "live") ? (
                    "✓"
                  ) : current ? (
                    <span className="size-2 animate-pulse rounded-full bg-accent" />
                  ) : (
                    ""
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-sm",
                      current || done ? "font-semibold text-text" : "text-text-subtle",
                    )}
                  >
                    {LABELS[s]}
                    {at && (
                      <span className="ml-2 text-xs text-text-subtle">
                        <RelativeTime iso={at} />
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-text-subtle">{DESCRIPTIONS[s]}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </Card>

      {job.lastError && (job.status === "failed" || job.status === "needs_reconciliation") && (
        <ErrorState
          title={job.status === "failed" ? "Launch failed" : "Needs reconciliation"}
          description={job.lastError}
          action={
            job.status === "failed" ? <ButtonLink href="/create">Try again</ButtonLink> : undefined
          }
        />
      )}

      {job.status === "live" && job.mint && (
        <Card className="flex flex-col gap-3 border-2 border-ink p-4 shadow-[var(--shadow-brutal)] sm:p-5">
          <p className="text-sm">
            Mint:{" "}
            <a
              className="num underline decoration-line-strong underline-offset-2"
              href={explorerUrl("address", job.mint)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(job.mint, 6)} ↗
            </a>
          </p>
          {job.signature && (
            <p className="text-sm">
              Creation tx:{" "}
              <a
                className="num underline decoration-line-strong underline-offset-2"
                href={explorerUrl("tx", job.signature)}
                target="_blank"
                rel="noreferrer"
              >
                {shortAddress(job.signature, 6)} ↗
              </a>
              <span className="ml-2 text-xs text-text-subtle">
                {job.sendMode === "jito"
                  ? `via Jito bundle${job.bundleId ? ` ${shortAddress(job.bundleId, 5)}` : ""}`
                  : "via regular RPC (not a private bundle)"}
              </span>
            </p>
          )}
          <ButtonLink href={`/token/${job.mint}`} variant="primary" className="self-start">
            View token
          </ButtonLink>
        </Card>
      )}
    </div>
  );
}

const DEPOSIT_TEXT: Record<NonNullable<LaunchJob["deposit"]>["status"], string> = {
  received: "Received. Kept if the coin goes live; refunded if the launch fails permanently.",
  kept: "Kept: it covered the on-chain creation cost of this coin.",
  refund_pending: "The launch failed, so your payment is being refunded to your wallet.",
  refunded: "Refunded to your wallet because the launch failed.",
};

/** Biaya launch yang dibayar creator: status disimpan / dikembalikan, dengan bukti on-chain. */
function DepositNote({ deposit }: { deposit: NonNullable<LaunchJob["deposit"]> }) {
  const link = (sig: string) => (
    <a
      className="num underline decoration-line-strong underline-offset-2"
      href={explorerUrl("tx", sig)}
      target="_blank"
      rel="noreferrer"
    >
      {shortAddress(sig, 6)} ↗
    </a>
  );
  return (
    <Card className="flex flex-col gap-1 p-4 text-sm sm:p-5">
      <p>
        Launch cost paid: <span className="num">{formatUnits(deposit.lamports, 9)} SOL</span> (
        {link(deposit.signature)})
      </p>
      <p className="text-text-muted">
        {DEPOSIT_TEXT[deposit.status]}
        {deposit.refundSignature && <> Refund tx: {link(deposit.refundSignature)}</>}
      </p>
    </Card>
  );
}
