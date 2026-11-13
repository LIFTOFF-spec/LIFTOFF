import { getSolPriceStatus } from "@/lib/api";
import { formatBps, formatNumber, getCluster } from "@/lib/format";

/**
 * Status harga SOL/USD yang dipakai threshold reserve (mainnet). Devnet tidak menampilkan apa pun:
 * harga asumsi sudah berlabel MOCK. Status harga tidak terbaca diperlakukan sama dengan tidak
 * terverifikasi, karena itulah yang dilakukan worker.
 */
export async function SolPriceNote() {
  if (getCluster() !== "mainnet-beta") return null;
  const res = await getSolPriceStatus().catch(() => null);
  const p = res?.data;
  if (p?.status === "verified" && p.usd !== null) {
    return (
      <li>
        SOL/USD now: <span className="num text-text">≈ ${formatNumber(p.usd)}</span> (verified: the
        StonkFun price is under {formatNumber(p.maxAgeSeconds, 0)} seconds old and within{" "}
        {formatBps(p.maxDeviationBps)} of Jupiter). This is an estimate, not a promise.
      </li>
    );
  }
  return (
    <li>
      SOL/USD now: <span className="text-text">not verified</span>. USD amounts show n/a and no
      reserve is deployed until the StonkFun and Jupiter prices are readable, fresh and in line.
    </li>
  );
}
