import type { GraduationInfo, GraduationState } from "@liftoff/shared";
import { explorerUrl, formatNumber, shortAddress } from "@/lib/format";
import { Tag } from "../ui/badges";
import { RelativeTime } from "../ui/time";

const STATE_LABEL: Record<
  GraduationState,
  { text: string; tone: "reserve" | "warn" | "danger" | "accent" }
> = {
  not_graduated: { text: "On bonding curve", tone: "accent" },
  migrating: { text: "Migrating to Raydium", tone: "warn" },
  pool_pending: { text: "Pool verification pending", tone: "warn" },
  verified: { text: "Pool verified", tone: "reserve" },
  failed: { text: "Pool check failed", tone: "danger" },
};

const CHECK_LABEL: Record<string, string> = {
  curve_complete: "Bonding curve complete",
  curve_migrated: "Curve migrated",
  pool_found: "Migrated pool found",
  pool_mints: "Pool pair matches the token",
  token_programs: "Classic SPL Token mints",
  pool_config: "Pool config = platform migration config",
  pool_creator: "Pool creator fee goes to the master wallet",
  migration_tx: "Pool created by the LaunchLab migration",
  lp_state: "Migration LP burned / locked",
  add_liquidity: "Add-liquidity supported",
};

function Link({ kind, id, chars = 6 }: { kind: "tx" | "address"; id: string; chars?: number }) {
  return (
    <a
      href={explorerUrl(kind, id)}
      target="_blank"
      rel="noreferrer"
      className="num underline decoration-line-strong underline-offset-2"
    >
      {shortAddress(id, chars)} ↗
    </a>
  );
}

/**
 * Spec §14 graduation monitoring: hasil verifikasi pool hasil migrasi dari worker graduation.
 * Hanya menampilkan bukti on-chain; tidak mengklaim lock permanen di luar yang terbaca.
 */
export function GraduationPanel({ graduation }: { graduation: GraduationInfo }) {
  const label = STATE_LABEL[graduation.state];
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Graduation (Raydium migration)</h3>
        <Tag tone={label.tone}>{label.text}</Tag>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-text-subtle">Raydium CPMM pool</dt>
          <dd className="mt-1">
            {graduation.cpmmPool ? <Link kind="address" id={graduation.cpmmPool} /> : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-text-subtle">Migration transaction</dt>
          <dd className="mt-1">
            {graduation.migrateSignature ? (
              <>
                <Link kind="tx" id={graduation.migrateSignature} chars={8} />
                {graduation.migratedAt && (
                  <span className="ml-1 text-xs text-text-subtle">
                    <RelativeTime iso={graduation.migratedAt} />
                  </span>
                )}
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-text-subtle">Migration LP (on-chain)</dt>
          <dd className="mt-1 text-text-muted">
            {graduation.lpBurnedPct !== null ? (
              <>
                {formatNumber(graduation.lpBurnedPct, 2)}% burned ·{" "}
                {formatNumber(graduation.lpLockedPct ?? 0, 2)}% held by the Raydium lock ·{" "}
                {formatNumber(graduation.lpFreePct ?? 0, 2)}% free
              </>
            ) : (
              "Not read yet"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-text-subtle">Conviction Reserve monitoring</dt>
          <dd className="mt-1">
            {graduation.reserveMonitoringActive ? (
              <Tag tone="success">Active</Tag>
            ) : (
              <Tag tone="warn">Off until the pool is verified</Tag>
            )}
          </dd>
        </div>
      </dl>
      <ul className="flex flex-col gap-1 text-xs">
        {graduation.checks.map((c) => (
          <li key={c.id} className="flex gap-2" title={c.detail}>
            <span className={c.ok ? "text-success" : "text-danger"} aria-hidden>
              {c.ok ? "✓" : "✗"}
            </span>
            <span className="sr-only">{c.ok ? "Passed:" : "Failed:"}</span>
            <span className="text-text-muted">
              {CHECK_LABEL[c.id] ?? c.id}
              <span className="block break-all text-text-subtle">{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-text-subtle">
        Checked <RelativeTime iso={graduation.checkedAt} /> by the LIFTOFF graduation worker.
        Reserve deployment stays disabled unless the pool is verified and accepts deposits.
      </p>
    </div>
  );
}
