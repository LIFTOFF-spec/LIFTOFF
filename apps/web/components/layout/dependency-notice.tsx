import { FEE_CONFIG } from "@liftoff/shared";
import Link from "next/link";
import { Tag } from "@/components/ui/badges";
import { Card } from "@/components/ui/primitives";
import { getStonkFunInfo } from "@/lib/api";
import { clusterCopy } from "@/lib/cluster";
import { explorerUrl, formatBps, getCluster, shortAddress } from "@/lib/format";

/**
 * Spec Rule 10: pengungkapan ketergantungan pada StonkFun & Raydium, dengan fee yang dibaca
 * on-chain (bukan teks statis). Di devnet StonkFun diemulasikan oleh Platform PDA LIFTOFF.
 */
export async function DependencyNotice({ compact = false }: { compact?: boolean }) {
  const info = await getStonkFunInfo()
    .then((r) => r.data)
    .catch(() => null);
  const cluster = getCluster();
  // Bila API tidak terjangkau, label emulasi hanya berlaku di luar mainnet.
  const emulated = info ? info.source === "devnet_emulation" : cluster !== "mainnet-beta";
  return (
    <Card className="flex flex-col gap-3 p-4 text-sm" aria-labelledby="dependency-title">
      <div className="flex flex-wrap items-center gap-2">
        <p id="dependency-title" className="font-semibold">
          Infrastructure dependency
        </p>
        {emulated && <Tag tone="warn">StonkFun emulated on {cluster}</Tag>}
      </div>
      <p className="text-text-muted">
        LIFTOFF is an interface and automation layer. Launches use a Raydium LaunchLab platform
        config from StonkFun, trading runs on Raydium LaunchLab (bonding curve) and Raydium CPMM
        (after graduation). LIFTOFF does not run its own bonding curve or exchange, and depends on
        both for availability, fees and graduation rules.
        {emulated && clusterCopy(cluster).dependencyNote}
      </p>
      {!compact && (
        <dl className="grid gap-2 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-text-subtle">Platform fee (StonkFun, not LIFTOFF)</dt>
            <dd className="num font-semibold">
              {info ? formatBps(info.platformFeeBps) : formatBps(FEE_CONFIG.platformFeeBps)}
            </dd>
          </div>
          <div>
            <dt className="text-text-subtle">Creator fee → 80/20 (curve · after graduation)</dt>
            <dd className="num font-semibold">
              {formatBps(info?.creatorFeeBps ?? FEE_CONFIG.creatorFeeBps)} ·{" "}
              {formatBps(info?.cpmmCreatorFeeBps ?? FEE_CONFIG.expectedCpmmCreatorFeeBps)}
            </dd>
          </div>
          <div>
            <dt className="text-text-subtle">Platform config</dt>
            <dd>
              {info ? (
                <a
                  className="num hover:underline"
                  href={explorerUrl("address", info.platformId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddress(info.platformId)} ↗
                </a>
              ) : (
                <span className="text-text-subtle">unavailable</span>
              )}
            </dd>
          </div>
        </dl>
      )}
      {info &&
        (info.platformFeeBps !== info.configured.platformFeeBps ||
          info.creatorFeeBps !== info.configured.creatorFeeBps) && (
          <p className="text-xs text-warn">
            On-chain fees differ from LIFTOFF’s configuration; the on-chain values above are what
            trades pay.
          </p>
        )}
      <p className="text-xs text-text-subtle">
        Fees shown are read live from the chain.{" "}
        <Link href="/faq" className="underline">
          FAQ
        </Link>
      </p>
    </Card>
  );
}
