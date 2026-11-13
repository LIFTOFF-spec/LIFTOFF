"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { xLinkUrl } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { getCluster, shortAddress } from "@/lib/format";
import { Tag } from "../ui/badges";
import { Button, buttonClass, cn } from "../ui/primitives";
import { useToast } from "../ui/toast";

function XGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-3.5", className)} fill="currentColor">
      <path d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.3-8.3L1.9 3h6.4l4.4 5.8L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z" />
    </svg>
  );
}

/**
 * Wallet = identitas utama (D9 revisi). Alur: Connect (Wallet Adapter) → Sign in (tanda tangan
 * pesan SIWS, tanpa transaksi) → sesi di API. Tidak pernah mengirim transaksi.
 */
export function WalletButton({ className }: { className?: string }) {
  const { publicKey, connecting, disconnect, wallet, signMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const session = useSession();
  const { toast } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signing, setSigning] = useState(false);
  const cluster = getCluster();

  if (!publicKey) {
    return (
      <Button
        className={cn("px-3", className)}
        onClick={() => setVisible(true)}
        disabled={connecting}
      >
        <span aria-hidden className="size-1.5 rounded-full bg-text-subtle" />
        {connecting ? (
          "Connecting…"
        ) : (
          <span>
            Connect<span className="hidden sm:inline"> wallet</span>
          </span>
        )}
        <Tag>{cluster}</Tag>
      </Button>
    );
  }

  const address = publicKey.toBase58();
  const signedIn = session.user?.wallet === address;

  async function signIn() {
    if (!signMessage) {
      toast({
        title: "This wallet can’t sign messages",
        description: "Use a wallet that supports message signing (e.g. Phantom, Solflare).",
        tone: "error",
      });
      return;
    }
    setSigning(true);
    try {
      await session.signIn(address, signMessage);
      toast({ title: "Signed in", description: "No transaction was sent.", tone: "success" });
    } catch (err) {
      toast({
        title: "Sign-in cancelled or failed",
        ...(err instanceof Error && err.message ? { description: err.message } : {}),
        tone: "error",
      });
    } finally {
      setSigning(false);
    }
  }

  if (!signedIn) {
    return (
      <Button
        variant="primary"
        className={cn("px-3", className)}
        onClick={signIn}
        disabled={signing || session.loading}
        title="Sign a message to prove you own this wallet. No transaction, no fee."
      >
        <span className="num">{shortAddress(address)}</span>
        {signing ? "Signing…" : "Sign in"}
      </Button>
    );
  }

  return (
    <div className="relative">
      <Button
        className={cn("px-3", className)}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        onClick={() => setMenuOpen((v) => !v)}
      >
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
        <span className="num">{shortAddress(address)}</span>
        <Tag tone="success">{cluster}</Tag>
      </Button>
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-2 w-56 rounded-xl border-2 border-ink bg-surface p-1.5 shadow-[var(--shadow-brutal)]"
        >
          <p className="px-2.5 py-2 text-xs text-text-muted">
            {wallet?.adapter.name ?? "Wallet"} · {cluster} · signed in
          </p>
          <button
            role="menuitem"
            type="button"
            className="w-full rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2"
            onClick={() => {
              void navigator.clipboard?.writeText(address);
              setMenuOpen(false);
            }}
          >
            Copy address
          </button>
          <button
            role="menuitem"
            type="button"
            className="w-full rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2"
            onClick={() => {
              setVisible(true);
              setMenuOpen(false);
            }}
          >
            Change wallet
          </button>
          <button
            role="menuitem"
            type="button"
            className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-danger hover:bg-surface-2"
            onClick={async () => {
              setMenuOpen(false);
              await session.logout();
              await disconnect();
            }}
          >
            Sign out &amp; disconnect
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Tautan akun X — OPSIONAL (D9 revisi). Hanya tampil setelah sign-in dengan wallet. Mode `x`:
 * OAuth 2.0 X lewat API. Mode `dev` (X_CLIENT_ID belum diisi): form handle bertanda DEV.
 */
export function XLinkButton({ className, compact }: { className?: string; compact?: boolean }) {
  const session = useSession();
  const { toast } = useToast();
  const pathname = usePathname();
  const [devOpen, setDevOpen] = useState(false);
  const [devHandle, setDevHandle] = useState("");
  const [busy, setBusy] = useState(false);

  if (session.loading || !session.user || session.xLinkMode === "disabled") return null;

  if (session.xHandle) {
    return (
      <Button
        className={cn("px-3", className)}
        onClick={async () => {
          await session.unlinkX();
          toast({ title: "X account unlinked" });
        }}
        title="Linked X account (click to unlink)"
      >
        <XGlyph />
        <span className="max-w-28 truncate">{session.xHandle}</span>
        {session.user.xDevLink && <Tag tone="warn">DEV</Tag>}
      </Button>
    );
  }

  const label = compact ? "Link X" : "Link X (optional)";

  if (session.xLinkMode === "x") {
    return (
      <a
        href={xLinkUrl(pathname || "/")}
        className={buttonClass("secondary", cn("px-3", className))}
      >
        <XGlyph />
        {label}
      </a>
    );
  }

  async function submitDev(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await session.devLinkX(devHandle);
      setDevOpen(false);
      toast({
        title: "X linked (DEV)",
        description: "Development link — not a real X account.",
        tone: "success",
      });
    } catch {
      toast({
        title: "DEV link failed",
        description: "Use 1–15 letters, numbers or _, not linked to another wallet.",
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <Button
        className={cn("px-3", className)}
        aria-expanded={devOpen}
        onClick={() => setDevOpen((v) => !v)}
        title="X OAuth is not configured on this server; a DEV link is used instead"
      >
        <XGlyph />
        {label}
        <Tag tone="warn">DEV</Tag>
      </Button>
      {devOpen && (
        <form
          onSubmit={submitDev}
          className="absolute right-0 z-40 mt-2 flex w-64 flex-col gap-2 rounded-xl border-2 border-ink bg-surface p-3 shadow-[var(--shadow-brutal)]"
        >
          <p className="text-xs text-text-muted">
            <Tag tone="warn">DEV LINK</Tag> X OAuth is not configured. Pick any handle to test
            locally — this is not a real X account.
          </p>
          <label className="sr-only" htmlFor="dev-handle">
            Handle
          </label>
          <input
            id="dev-handle"
            value={devHandle}
            onChange={(e) => setDevHandle(e.target.value)}
            placeholder="@creator_demo"
            maxLength={16}
            autoComplete="off"
            className="rounded-lg border-2 border-line bg-bg px-2.5 py-1.5 text-sm focus:border-ink focus:outline-none"
          />
          <Button type="submit" variant="primary" disabled={busy || !devHandle.trim()}>
            {busy ? "Linking…" : "Link (DEV)"}
          </Button>
        </form>
      )}
    </div>
  );
}
