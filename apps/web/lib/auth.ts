"use client";

import { base58Encode, type SessionInfo } from "@liftoff/shared";
import { useSyncExternalStore } from "react";
import { devLinkX, getSession, logout, siwsNonce, siwsVerify, unlinkX } from "./api";

// Sesi dari API (`/api/auth/me`). Identitas utama = wallet lewat Sign-In With Solana; akun X
// opsional. Satu store bersama untuk semua komponen.

type State =
  { status: "loading" } | { status: "ready"; session: SessionInfo } | { status: "error" };

let state: State = { status: "loading" };
let started = false;
const listeners = new Set<() => void>();

function setState(next: State) {
  state = next;
  listeners.forEach((l) => l());
}

async function refresh() {
  try {
    setState({ status: "ready", session: await getSession() });
  } catch {
    setState({ status: "error" });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!started) {
    started = true;
    void refresh();
  }
  return () => listeners.delete(listener);
}

const LOADING: State = { status: "loading" };

export function useSession() {
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => LOADING,
  );
  const session = current.status === "ready" ? current.session : null;
  return {
    loading: current.status === "loading",
    error: current.status === "error",
    xLinkMode: session?.xLinkMode ?? "disabled",
    user: session?.user ?? null,
    /** Handle X tertaut untuk tampilan, mis. "@alice"; null jika belum ditautkan. */
    xHandle: session?.user?.xHandle ? `@${session.user.xHandle}` : null,
    refresh,
    /**
     * Sign-In With Solana: minta pesan dari API, tanda tangani dengan wallet (tanpa transaksi),
     * lalu verifikasi di API.
     */
    async signIn(wallet: string, signMessage: (message: Uint8Array) => Promise<Uint8Array>) {
      const { message } = await siwsNonce(wallet);
      const signature = await signMessage(new TextEncoder().encode(message));
      setState({
        status: "ready",
        session: await siwsVerify(wallet, message, base58Encode(signature)),
      });
    },
    async devLinkX(handle: string) {
      setState({ status: "ready", session: await devLinkX(handle) });
    },
    async unlinkX() {
      setState({ status: "ready", session: await unlinkX() });
    },
    async logout() {
      await logout();
      await refresh();
    },
  };
}
