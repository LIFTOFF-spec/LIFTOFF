import type { StatStatus } from "@liftoff/shared";
import type { ReactNode } from "react";
import { explorerUrl, shortAddress } from "@/lib/format";
import { MockBadge, StatusBadge } from "../ui/badges";
import { EmptyState } from "../ui/states";
import { RelativeTime } from "../ui/time";

export interface TxRow {
  key: string;
  type: ReactNode;
  detail: ReactNode;
  amount: ReactNode;
  signature: string;
  createdAt: string;
  status?: StatStatus;
}

/** Riwayat transaksi dengan link explorer (cluster dari env). */
export function TransactionHistory({
  rows,
  isMock,
  emptyTitle = "No transactions yet",
  caption,
}: {
  rows: TxRow[];
  isMock: boolean;
  emptyTitle?: string;
  caption: string;
}) {
  if (rows.length === 0) return <EmptyState title={emptyTitle} />;
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
      <table className="w-full min-w-[560px] text-sm">
        <caption className="sr-only">
          {caption}
          {isMock ? " (sample data / MOCK)" : ""}
        </caption>
        <thead className="bg-surface-2 text-left text-xs text-text-muted">
          <tr>
            <th scope="col" className="px-4 py-2.5 font-normal">
              Type
            </th>
            <th scope="col" className="px-3 py-2.5 font-normal">
              Detail
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-normal">
              <span className="inline-flex items-center gap-1.5">
                Amount {isMock && <MockBadge />}
              </span>
            </th>
            <th scope="col" className="px-3 py-2.5 font-normal">
              Time
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-normal">
              Tx
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="px-4 py-2.5 whitespace-nowrap">{r.type}</td>
              <td className="px-3 py-2.5 text-text-muted">{r.detail}</td>
              <td className="num px-3 py-2.5 text-right whitespace-nowrap">{r.amount}</td>
              <td className="px-3 py-2.5 text-xs whitespace-nowrap text-text-subtle">
                <span className="flex flex-col gap-1">
                  <RelativeTime iso={r.createdAt} />
                  {r.status && <StatusBadge status={r.status} />}
                </span>
              </td>
              <td className="px-4 py-2.5 text-right">
                <a
                  href={explorerUrl("tx", r.signature)}
                  target="_blank"
                  rel="noreferrer"
                  className="num text-xs text-text-muted underline decoration-line-strong underline-offset-2 hover:text-text"
                  title={isMock ? "Sample signature — not on chain" : r.signature}
                >
                  {shortAddress(r.signature, 5)} ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
