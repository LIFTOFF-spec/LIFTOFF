import type { ReserveDeploymentView } from "@liftoff/shared";
import Link from "next/link";
import { explorerUrl, formatNumber, shortAddress } from "@/lib/format";
import { Tag } from "../ui/badges";
import { Card } from "../ui/primitives";
import { EmptyState } from "../ui/states";
import { RelativeTime } from "../ui/time";

function Ext({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="num text-xs underline decoration-line-strong underline-offset-2"
    >
      {label} ↗
    </a>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <dt className="text-text-muted">{label}</dt>
      <dd className="num text-right">{children}</dd>
    </div>
  );
}

/**
 * Riwayat deployment Conviction Reserve (Spec §11 Phase 5): token, mint, reserve sebelum, jumlah
 * dideploy, pool, signature, bukti lock (burn LP), sisa reserve. Semua tautan ke explorer.
 */
export function ReserveDeploymentList({
  deployments,
  showToken = true,
}: {
  deployments: ReserveDeploymentView[];
  showToken?: boolean;
}) {
  if (deployments.length === 0) {
    return (
      <EmptyState
        title="No reserve deployments yet"
        description="Deployments appear here once a graduated token passes every safety check."
      />
    );
  }
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {deployments.map((d) => (
        <li key={d.id}>
          <Card className="h-full p-4">
            <div className="flex flex-wrap items-center gap-2">
              {showToken && (
                <Link href={`/token/${d.tokenMint}`} className="font-semibold hover:underline">
                  {d.tokenName} <span className="text-text-muted">${d.ticker}</span>
                </Link>
              )}
              {d.lock.verified ? (
                <Tag tone="success">LP burned · verified</Tag>
              ) : (
                <Tag tone="warn">Lock not verified</Tag>
              )}
              <span className="ml-auto text-xs text-text-subtle">
                <RelativeTime iso={d.createdAt} />
              </span>
            </div>
            <dl className="mt-3 divide-y divide-line text-sm">
              {showToken && (
                <Row label="Token mint">
                  <Ext
                    href={explorerUrl("address", d.tokenMint)}
                    label={shortAddress(d.tokenMint, 5)}
                  />
                </Row>
              )}
              <Row label="Reserve before">
                {formatNumber(d.reserveBefore, 9)} {d.quoteSymbol}
              </Row>
              <Row label="Amount deployed">
                {formatNumber(d.amountDeployed, 9)} {d.quoteSymbol}
              </Row>
              <Row label="Added to pool">
                {formatNumber(d.quoteAdded, 9)} {d.quoteSymbol} + {formatNumber(d.tokenAdded, 2)}{" "}
                {d.ticker}
              </Row>
              <Row label="Liquidity pool">
                <Ext href={explorerUrl("address", d.pool)} label={shortAddress(d.pool, 5)} />
              </Row>
              <Row label="Transaction">
                <Ext href={explorerUrl("tx", d.signature)} label={shortAddress(d.signature, 5)} />
              </Row>
              <Row label="Lock verification">
                {d.lock.verified ? (
                  <Ext
                    href={explorerUrl("tx", d.lock.proofSignature)}
                    label={`${formatNumber(d.lpBurned, 0)} LP burned`}
                  />
                ) : (
                  <span className="text-text-subtle">Burn not proven</span>
                )}
              </Row>
              <Row label="Remaining reserve">
                {formatNumber(d.remainingReserve, 9)} {d.quoteSymbol}
              </Row>
            </dl>
          </Card>
        </li>
      ))}
    </ul>
  );
}
