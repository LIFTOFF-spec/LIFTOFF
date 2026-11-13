import type { LaunchRules } from "@liftoff/shared";
import { parseUnits } from "./units";

/**
 * Deposit launch = biaya launch yang dibayar creator (BUILD_PLAN §8). Wallet creator mentransfer
 * SOL ke master wallet, lalu signature-nya dikirim bersama POST /api/launch. Signature disimpan di
 * localStorage segera setelah wallet mengirim transaksi, sehingga jika request launch gagal (atau
 * halaman dimuat ulang) launch berikutnya MEMAKAI ULANG transfer yang sama — tidak bayar dua kali.
 */
export interface PendingDeposit {
  wallet: string;
  signature: string;
  lamports: string;
  recipient: string;
  /** ms epoch saat transaksi dikirim wallet. */
  sentAt: number;
  /** Idempotency-Key + input yang terakhir dipakai bersama deposit ini (replay aman). */
  idempotencyKey: string | null;
  inputKey: string | null;
}

type DepositRules = LaunchRules["deposit"];

const STORAGE_KEY = "liftoff.launchDeposit.v1";

/** API menolak deposit > 24 jam; web berhenti memakai ulang sedikit lebih awal. */
export const DEPOSIT_REUSE_WINDOW_MS = 23 * 60 * 60 * 1000;

/** Cadangan fee jaringan transaksi transfer (1 signature = 5.000 lamport, plus margin). */
export const DEPOSIT_FEE_BUFFER_LAMPORTS = 10_000n;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Deposit tersimpan yang masih boleh dipakai untuk wallet & aturan deposit saat ini. */
export function loadPendingDeposit(
  wallet: string,
  rules: DepositRules,
  now = Date.now(),
  storage = browserStorage(),
): PendingDeposit | null {
  let saved: PendingDeposit;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    saved = JSON.parse(raw) as PendingDeposit;
  } catch {
    return null;
  }
  const usable =
    saved.wallet === wallet &&
    saved.recipient === rules.recipient &&
    BigInt(saved.lamports) >= BigInt(rules.lamports) &&
    now - saved.sentAt < DEPOSIT_REUSE_WINDOW_MS;
  if (!usable && saved.wallet === wallet) clearPendingDeposit(storage);
  return usable ? saved : null;
}

export function savePendingDeposit(d: PendingDeposit, storage = browserStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(d));
  } catch {
    // Penyimpanan diblokir: resume hanya berlaku selama halaman terbuka (state React).
  }
}

export function clearPendingDeposit(storage = browserStorage()): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // abaikan
  }
}

/**
 * Saldo yang dibutuhkan SEBELUM membayar: biaya launch + fee transfer + saldo minimum wallet
 * (syarat minimum dicek lagi oleh API setelah deposit terkirim).
 */
export function requiredBalanceLamports(rules: LaunchRules): bigint {
  const min = parseUnits(rules.minBalanceSol, 9) ?? 0n;
  return BigInt(rules.deposit.lamports) + DEPOSIT_FEE_BUFFER_LAMPORTS + min;
}

/**
 * Setelah API menolak deposit (`launch_deposit_invalid`): simpan untuk dicoba lagi hanya jika
 * kegagalannya sementara (API tidak bisa mengecek, atau transaksi sudah terkonfirmasi on-chain
 * tetapi RPC API belum melihatnya). Selain itu deposit itu tidak akan pernah diterima.
 */
export function keepAfterInvalid(message: string, confirmedOnChain: boolean): boolean {
  if (/could not check/i.test(message)) return true;
  if (/not found|not confirmed/i.test(message)) return confirmedOnChain;
  return false;
}

export interface DepositProblem {
  code: string;
  message: string;
}

/** Error wallet / RPC saat membayar biaya launch → pesan yang jelas untuk pengguna. */
export function depositProblemOf(err: unknown): DepositProblem {
  const e = err as { name?: string; message?: string };
  const msg = e?.message ?? String(err);
  if (/reject|denied|cancel/i.test(`${e?.name} ${msg}`)) {
    return {
      code: "wallet_rejected",
      message:
        "You rejected the payment in your wallet. Nothing was sent and nothing was launched.",
    };
  }
  if (/insufficient|0x1\b|debit an account/i.test(msg)) {
    return {
      code: "insufficient_balance",
      message: "Not enough SOL in your wallet for the launch cost plus network fee.",
    };
  }
  if (/block height exceeded|expired|blockhash not found/i.test(msg)) {
    return {
      code: "expired",
      message: "The payment expired before it landed. Nothing was charged — try again.",
    };
  }
  return { code: "unknown", message: msg || "The payment could not be sent." };
}
