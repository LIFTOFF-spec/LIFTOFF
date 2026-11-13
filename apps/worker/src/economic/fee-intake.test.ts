import { describe, expect, it } from "vitest";
import { classifyForwardCredit, classifyNativeForward, type ForwardRules } from "./fee-intake";
import type { InboundCredit } from "./ports";

const RULES: ForwardRules = {
  master: "MASTER",
  launchlabProgram: "LAUNCHLAB",
  forwarders: ["STONKFUN"],
  quoteMints: ["WSOL"],
};
const credit = (c: Partial<InboundCredit> = {}): InboundCredit => ({
  signature: "sig",
  slot: 1,
  failed: false,
  mint: "WSOL",
  amount: 100n,
  signers: ["SOMEONE"],
  sourceOwners: [],
  programs: [],
  ...c,
});

describe("classifyForwardCredit", () => {
  it.each([
    ["forwarder dikenal (signer)", credit({ signers: ["STONKFUN"] }), "known_forwarder"],
    ["forwarder dikenal (owner sumber)", credit({ sourceOwners: ["STONKFUN"] }), "known_forwarder"],
    ["diteruskan di dalam trade LaunchLab", credit({ programs: ["LAUNCHLAB"] }), "launchlab_trade"],
  ])("%s → diakui", (_n, c, evidence) => {
    expect(classifyForwardCredit(c, RULES)).toMatchObject({ ok: true, evidence });
  });

  it.each([
    ["transaksi master sendiri", credit({ signers: ["MASTER", "STONKFUN"] }), false],
    ["transaksi gagal", credit({ failed: true, signers: ["STONKFUN"] }), false],
    ["bukan kredit", credit({ amount: -5n, signers: ["STONKFUN"] }), false],
    ["mint lain", credit({ mint: "OTHER", signers: ["STONKFUN"] }), true],
    ["pengirim tak dikenal", credit(), true],
  ])("%s → ditolak", (_n, c, alert) => {
    expect(classifyForwardCredit(c, RULES)).toMatchObject({ ok: false, alert });
  });
});

describe("classifyNativeForward", () => {
  it("hanya transfer yang ditandatangani forwarder dikenal yang dihitung", () => {
    expect(classifyNativeForward(credit({ signers: ["STONKFUN"] }), RULES)).toMatchObject({
      ok: true,
      evidence: "known_forwarder",
      forwarder: "STONKFUN",
    });
  });

  it.each([
    ["deposit atau isi ulang", credit()],
    ["transaksi master sendiri", credit({ signers: ["MASTER", "STONKFUN"] })],
    ["transaksi gagal", credit({ failed: true, signers: ["STONKFUN"] })],
    ["saldo turun", credit({ amount: -5n, signers: ["STONKFUN"] })],
    ["bukti LaunchLab saja tidak cukup", credit({ programs: ["LAUNCHLAB"] })],
  ])("%s → tidak dihitung, tanpa alert", (_n, c) => {
    expect(classifyNativeForward(c, RULES)).toMatchObject({ ok: false, alert: false });
  });
});
