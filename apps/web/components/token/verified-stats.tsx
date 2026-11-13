import type { Stat, TransparencySummary } from "@liftoff/shared";
import { Tag } from "../ui/badges";
import { SectionTitle } from "../ui/primitives";
import { StatCard } from "../ui/stat-card";
import { formatNumber } from "@/lib/format";

/** Jumlah native per aset di bawah kartu (USD bisa tidak tersedia). */
function NativeLine({ stats }: { stats: Stat[] }) {
  if (stats.length === 0) return null;
  return (
    <span className="num text-xs text-text-muted">
      {stats.map((s) => `${formatNumber(s.value ?? "0", 6)} ${s.unit}`).join(" · ")}
    </span>
  );
}

/** Kartu "Verified" yang sama di beranda dan halaman Transparency. */
export function VerifiedStats({
  verified,
  title = "Verified",
}: {
  verified: TransparencySummary["verified"];
  title?: string;
}) {
  const native = verified.native;
  return (
    <section aria-labelledby="verified-title">
      <SectionTitle id="verified-title" aside={<Tag tone="success">Verified on-chain</Tag>}>
        {title}
      </SectionTitle>
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Creator fees received"
          stat={verified.feesReceivedUsd}
          definition="Creator fees paid to the LIFTOFF master wallet, attributed per token from each trade’s on-chain event."
          footer={<NativeLine stats={native.feesReceived} />}
        />
        <StatCard
          label="Spent on buyback & burn"
          stat={verified.burnedUsd}
          definition="Quote already spent buying tokens, with a verified burn."
          footer={<NativeLine stats={native.burned} />}
        />
        <StatCard
          label="Reserve contributions"
          stat={verified.reserveContributedUsd}
          definition="Total fee share sent to every token’s Conviction Reserve."
          footer={<NativeLine stats={native.reserveContributed} />}
        />
        <StatCard
          label="Reserve deployed"
          stat={verified.reserveDeployedUsd}
          definition="Reserve already added to each token’s CPMM pool liquidity."
          footer={<NativeLine stats={native.reserveDeployed} />}
        />
      </div>
    </section>
  );
}
