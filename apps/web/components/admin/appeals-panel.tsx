"use client";

import type { LaunchAppeal } from "@liftoff/shared";
import { useEffect, useState } from "react";
import { WalletButton } from "@/components/layout/account-buttons";
import { Tag } from "@/components/ui/badges";
import { Button, Card } from "@/components/ui/primitives";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/states";
import { RelativeTime } from "@/components/ui/time";
import { useToast } from "@/components/ui/toast";
import { ApiRequestError, getAdminAppeals, reviewAppeal } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { shortAddress } from "@/lib/format";

/**
 * Panel peninjauan banding anti-copycat (Spec §7). Server menegakkan akses (ADMIN_WALLETS +
 * sesi SIWS); UI ini hanya menyembunyikan panel untuk wallet lain.
 */
export function AppealsPanel() {
  const session = useSession();
  const { toast } = useToast();
  const [scope, setScope] = useState<"pending" | "all">("pending");
  const [appeals, setAppeals] = useState<LaunchAppeal[] | null>(null);
  const [error, setError] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = session.user?.isAdmin ?? false;

  const [reloadKey, setReloadKey] = useState(0);
  const load = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    getAdminAppeals(scope)
      .then((res) => {
        if (cancelled) return;
        setAppeals(res.data);
        setError(false);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, scope, reloadKey]);

  if (session.loading) return <Skeleton className="h-40 rounded-xl" />;
  if (!session.user) {
    return (
      <Card className="flex flex-col items-start gap-3 p-5">
        <p className="font-semibold">Sign in with an admin wallet.</p>
        <WalletButton />
      </Card>
    );
  }
  if (!isAdmin) {
    return (
      <EmptyState
        title="Not an admin wallet"
        description={`${shortAddress(session.user.wallet)} is not on the admin allowlist.`}
      />
    );
  }

  async function decide(id: string, decision: "approved" | "rejected") {
    setBusy(id);
    try {
      await reviewAppeal(id, decision, notes[id] ?? "");
      toast({ title: `Appeal ${decision}`, tone: "success" });
      load();
    } catch (err) {
      toast({
        title: "Review failed",
        description: err instanceof ApiRequestError ? err.message : "Try again.",
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2 text-sm">
        {(["pending", "all"] as const).map((s) => (
          <Button key={s} variant={scope === s ? "primary" : "ghost"} onClick={() => setScope(s)}>
            {s === "pending" ? "Pending" : "All"}
          </Button>
        ))}
      </div>
      {error ? (
        <ErrorState title="Couldn’t load appeals" description="Reload the page." />
      ) : !appeals ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : appeals.length === 0 ? (
        <EmptyState
          title="No appeals"
          description="High-risk launches that are appealed show up here."
        />
      ) : (
        appeals.map((a) => (
          <Card key={a.id} className="flex flex-col gap-3 p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">
                ${a.ticker} · {a.name}
              </span>
              <Tag
                tone={
                  a.status === "pending" ? "warn" : a.status === "rejected" ? "danger" : "success"
                }
              >
                {a.status}
              </Tag>
              <Tag tone="danger">
                {a.risk.level} · score {a.risk.score}
              </Tag>
              <span className="ml-auto text-xs text-text-subtle">
                {shortAddress(a.wallet)} · <RelativeTime iso={a.createdAt} />
              </span>
            </div>
            <ul className="list-disc pl-5 text-xs text-text-muted">
              {a.risk.indicators.map((i) => (
                <li key={`${i.code}-${i.relatedTicker ?? ""}`}>{i.message}</li>
              ))}
            </ul>
            <p className="rounded-lg bg-surface-2 p-2 text-text-muted">“{a.message}”</p>
            <p className="text-xs text-text-subtle">
              Pair {a.pairId} ·{" "}
              {[a.links.website, a.links.telegram, a.links.x].filter(Boolean).join(" · ") ||
                "no links"}
            </p>
            {a.status === "pending" ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  aria-label="Review note"
                  placeholder="Note (optional, shown to the creator)"
                  value={notes[a.id] ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))}
                  className="flex-1 rounded-lg border border-line bg-bg px-2 py-1.5"
                />
                <Button
                  variant="primary"
                  disabled={busy === a.id}
                  onClick={() => decide(a.id, "approved")}
                >
                  Approve
                </Button>
                <Button disabled={busy === a.id} onClick={() => decide(a.id, "rejected")}>
                  Reject
                </Button>
              </div>
            ) : (
              <p className="text-xs text-text-subtle">
                Reviewed by {a.reviewedBy ? shortAddress(a.reviewedBy) : "—"}
                {a.reviewNote ? ` · “${a.reviewNote}”` : ""}
              </p>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
