import type { LaunchRules } from "@liftoff/shared";
import { describe, expect, it } from "vitest";
import {
  DEPOSIT_REUSE_WINDOW_MS,
  clearPendingDeposit,
  depositProblemOf,
  keepAfterInvalid,
  loadPendingDeposit,
  requiredBalanceLamports,
  savePendingDeposit,
  type KeyValueStorage,
  type PendingDeposit,
} from "./deposit";

function memory(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const RULES: LaunchRules["deposit"] = {
  enabled: true,
  sol: "0.0085",
  lamports: "8500000",
  recipient: "Master1111111111111111111111111111111111111",
};

const SAVED: PendingDeposit = {
  wallet: "Creator11111111111111111111111111111111111",
  signature: "5".repeat(87),
  lamports: "8500000",
  recipient: RULES.recipient,
  sentAt: 1_000_000,
  idempotencyKey: "key-1",
  inputKey: "{}",
};

describe("deposit tersimpan (resume tanpa bayar dua kali)", () => {
  it("dipakai ulang untuk wallet yang sama dalam jendela 23 jam", () => {
    const s = memory();
    savePendingDeposit(SAVED, s);
    expect(loadPendingDeposit(SAVED.wallet, RULES, SAVED.sentAt + 60_000, s)).toEqual(SAVED);
  });

  it("tidak dipakai untuk wallet lain, dan tidak dihapus", () => {
    const s = memory();
    savePendingDeposit(SAVED, s);
    expect(loadPendingDeposit("Other", RULES, SAVED.sentAt, s)).toBeNull();
    expect(s.data.size).toBe(1);
  });

  it("kedaluwarsa, jumlah kurang, atau penerima berubah → dibuang", () => {
    for (const [rules, now] of [
      [RULES, SAVED.sentAt + DEPOSIT_REUSE_WINDOW_MS],
      [{ ...RULES, lamports: "9000000" }, SAVED.sentAt],
      [{ ...RULES, recipient: "Else" }, SAVED.sentAt],
    ] as const) {
      const s = memory();
      savePendingDeposit(SAVED, s);
      expect(loadPendingDeposit(SAVED.wallet, rules, now, s)).toBeNull();
      expect(s.data.size).toBe(0);
    }
  });

  it("data rusak / storage kosong aman", () => {
    const s = memory();
    s.setItem("liftoff.launchDeposit.v1", "{not json");
    expect(loadPendingDeposit(SAVED.wallet, RULES, 0, s)).toBeNull();
    clearPendingDeposit(s);
    expect(loadPendingDeposit(SAVED.wallet, RULES, 0, null)).toBeNull();
  });
});

describe("saldo yang dibutuhkan sebelum membayar", () => {
  it("biaya launch + fee transfer + saldo minimum (dicek ulang setelah deposit)", () => {
    const rules = { minBalanceSol: "0.05", deposit: RULES } as LaunchRules;
    expect(requiredBalanceLamports(rules)).toBe(8_500_000n + 10_000n + 50_000_000n);
    expect(requiredBalanceLamports({ ...rules, minBalanceSol: "0" })).toBe(8_510_000n);
  });
});

describe("deposit ditolak API", () => {
  it("disimpan hanya untuk kegagalan sementara", () => {
    expect(keepAfterInvalid("Could not check the deposit transaction right now.", false)).toBe(
      true,
    );
    expect(keepAfterInvalid("Deposit transaction not found (or not confirmed yet).", true)).toBe(
      true,
    );
    expect(keepAfterInvalid("Deposit transaction not found (or not confirmed yet).", false)).toBe(
      false,
    );
    expect(keepAfterInvalid("Deposit transaction is too old. Send a new deposit.", true)).toBe(
      false,
    );
    expect(keepAfterInvalid("Deposit transaction failed on-chain.", true)).toBe(false);
  });
});

describe("pesan error wallet", () => {
  it("menolak di wallet, saldo kurang, kedaluwarsa", () => {
    expect(
      depositProblemOf({
        name: "WalletSendTransactionError",
        message: "User rejected the request.",
      }).code,
    ).toBe("wallet_rejected");
    expect(
      depositProblemOf(
        new Error("Attempt to debit an account but found no record of a prior credit."),
      ).code,
    ).toBe("insufficient_balance");
    expect(depositProblemOf(new Error("block height exceeded")).code).toBe("expired");
    expect(depositProblemOf(new Error("boom")).message).toBe("boom");
  });
});
