/** Chain, signer, dan sender palsu untuk test economic engine (tanpa jaringan). */
import { randomBytes } from "node:crypto";
import { base58Encode, WSOL_MINT, type PairConfig } from "@liftoff/shared";
import type { CpmmClaimable } from "@liftoff/solana/economic";
import { associatedTokenAddress, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "@liftoff/solana/trade";
import { SignerClientError, type BuiltTx, type SignatureStatus } from "../launch/ports";
import { reserveVaultAddresses, type ReservePoolMetrics } from "@liftoff/solana/reserve";
import type {
  BuybackPreparation,
  EconomicChain,
  LandedTx,
  ReserveDeployPlanFields,
  ReserveDeployPreparation,
  ReserveDeployProof,
  InboundCredit,
} from "./ports";

type FakeTx =
  | { kind: "claim_curve"; quoteMint: string }
  | { kind: "claim_cpmm"; pool: string }
  | { kind: "buyback"; mint: string; quoteMint: string; amountIn: string; minOut: string }
  | { kind: "burn"; mint: string; amount: string; close: boolean }
  | { kind: "reserve_fund"; tokenMint: string; quoteMint: string; amount: string; create: boolean }
  | {
      kind: "reserve_deploy";
      tokenMint: string;
      quoteMint: string;
      swapIn: string;
      swapMinOut: string;
      lpAmount: string;
      maxQuote: string;
      createToken: boolean;
    };

const enc = (t: unknown) => Buffer.from(JSON.stringify(t)).toString("base64");
const dec = <T>(b64: string) => JSON.parse(Buffer.from(b64, "base64").toString()) as T;

export class CrashError extends Error {
  constructor() {
    super("worker crash (simulasi)");
  }
}

export class FakeEconomicChain implements EconomicChain {
  height = 1_000;
  slot = 5_000;
  masterSol = 3_000_000_000n;
  balances = new Map<string, bigint>();
  curveVaults = new Map<string, bigint>();
  pools = new Map<string, CpmmClaimable>();
  statuses = new Map<string, SignatureStatus>();
  landed = new Map<string, LandedTx>();
  /** Token keluar per 1 unit quote (buyback). */
  rate = 1_000n;
  /** Hasil eksekusi on-chain lebih kecil dari quote (harga bergerak) dalam bps. */
  executionShortfallBps = 0n;
  route: "launchlab" | "cpmm" = "launchlab";
  prepareError: string | null = null;
  priceImpactBps = 50;
  executed: FakeTx[] = [];

  /** Mint yang memakai Token-2022 (token baru); lainnya SPL klasik. */
  token2022 = new Set<string>();

  constructor(readonly master: string) {}

  programOf(mint: string) {
    return this.token2022.has(mint) ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  }
  ata(mint: string) {
    return associatedTokenAddress(this.master, mint, this.programOf(mint));
  }
  async masterTokenAccount(mint: string) {
    return this.ata(mint);
  }
  async reserveVault(tokenMint: string, quoteMint: string) {
    return reserveVaultAddresses(this.master, tokenMint, {
      token: this.programOf(tokenMint),
      quote: this.programOf(quoteMint),
    });
  }
  private add(account: string, v: bigint) {
    this.balances.set(account, (this.balances.get(account) ?? 0n) + v);
  }

  async masterLamports() {
    return this.masterSol;
  }
  async tokenBalance(account: string) {
    return this.balances.get(account) ?? 0n;
  }
  async curveClaimable(quoteMint: string) {
    return { vault: `vault-${quoteMint}`, amount: this.curveVaults.get(quoteMint) ?? 0n };
  }
  async cpmmClaimable(pool: string) {
    return this.pools.get(pool) ?? null;
  }
  async prepareBuyback(p: {
    mint: string;
    pair: PairConfig;
    amountIn: bigint;
    slippageBps: number;
  }): Promise<BuybackPreparation> {
    if (this.prepareError) return { ok: false, reason: this.prepareError };
    const expectedOut = p.amountIn * this.rate;
    return {
      ok: true,
      buyback: {
        route: this.route,
        amountIn: p.amountIn,
        expectedOut,
        minOut: (expectedOut * BigInt(10_000 - p.slippageBps)) / 10_000n,
        priceImpactBps: this.priceImpactBps,
      },
    };
  }
  private built(t: FakeTx): BuiltTx {
    return { transaction: enc(t), lastValidBlockHeight: this.height + 150 };
  }
  async buildClaimCurve(quoteMint: string) {
    return this.built({ kind: "claim_curve", quoteMint });
  }
  async buildClaimCpmm(pool: string) {
    return this.built({ kind: "claim_cpmm", pool });
  }
  async buildBuyback(p: { mint: string; pair: PairConfig; amountIn: bigint; minOut: bigint }) {
    return this.built({
      kind: "buyback",
      mint: p.mint,
      quoteMint: p.pair.mint,
      amountIn: p.amountIn.toString(),
      minOut: p.minOut.toString(),
    });
  }
  async buildBurn(p: { mint: string; amount: bigint; closeAccount: boolean }) {
    return this.built({
      kind: "burn",
      mint: p.mint,
      amount: p.amount.toString(),
      close: p.closeAccount,
    });
  }
  async signatureStatuses(signatures: string[]) {
    return signatures.map((s) => this.statuses.get(s) ?? null);
  }
  async blockHeight() {
    return this.height;
  }
  /** Kredit masuk per akun (strategi forwarded), terlama dulu. */
  inbound = new Map<string, InboundCredit[]>();
  /** Mensimulasikan transfer masuk ke ATA quote master (mis. fee yang diteruskan StonkFun). */
  forward(
    mint: string,
    amount: bigint,
    c: Partial<Omit<InboundCredit, "mint" | "amount">> & { signature: string },
  ) {
    const account = this.ata(mint);
    this.add(account, amount);
    const list = this.inbound.get(account) ?? [];
    list.push({
      slot: this.slot,
      failed: false,
      signers: [],
      sourceOwners: [],
      programs: [],
      ...c,
      mint,
      amount,
    });
    this.inbound.set(account, list);
  }
  async inboundCredits(account: string, opts: { until: string | null; limit: number }) {
    const all = this.inbound.get(account) ?? [];
    const from = opts.until ? all.findIndex((c) => c.signature === opts.until) + 1 : 0;
    const credits = all.slice(from, from + opts.limit);
    return { credits, newest: credits.at(-1)?.signature ?? opts.until };
  }
  inboundNative: InboundCredit[] = [];
  /** Signature yang belum tersedia di RPC: pembacaan berhenti di sini (kursor tidak melewatinya). */
  nativeUnavailable = new Set<string>();
  /** Mensimulasikan SOL biasa masuk ke wallet master. */
  forwardNative(
    amount: bigint,
    c: Partial<Omit<InboundCredit, "mint" | "amount">> & { signature: string },
  ) {
    this.masterSol += amount;
    this.inboundNative.push({
      slot: this.slot,
      failed: false,
      signers: [],
      sourceOwners: [],
      programs: [],
      ...c,
      mint: WSOL_MINT,
      amount,
    });
  }
  async inboundNativeCredits(_wallet: string, opts: { until: string | null }) {
    const from = opts.until
      ? this.inboundNative.findIndex((c) => c.signature === opts.until) + 1
      : 0;
    const credits: InboundCredit[] = [];
    let cursor = opts.until;
    for (const c of this.inboundNative.slice(from)) {
      if (this.nativeUnavailable.has(c.signature)) break;
      credits.push(c);
      cursor = c.signature;
    }
    return { credits, cursor };
  }
  async landedTx(signature: string) {
    return this.landed.get(signature) ?? null;
  }

  // ---------------------------------------------------------------- Conviction Reserve

  /** Pool CPMM per mint token (monitoring). */
  reservePools = new Map<string, ReservePoolMetrics>();
  existing = new Set<string>();
  proofs = new Map<string, ReserveDeployProof>();
  /** Burn LP di transaksi deploy kurang dari rencana (uji lock tidak terverifikasi). */
  lpBurnShortfall = 0n;

  vault(mint: string, quoteMint?: string) {
    return reserveVaultAddresses(this.master, mint, {
      token: this.programOf(mint),
      quote: quoteMint ? this.programOf(quoteMint) : TOKEN_PROGRAM,
    });
  }
  async accountExists(address: string) {
    return this.existing.has(address);
  }
  async reservePool(p: { mint: string }) {
    return this.reservePools.get(p.mint) ?? null;
  }
  async prepareReserveDeploy(p: {
    mint: string;
    deployQuote: bigint;
    slippageBps: number;
  }): Promise<ReserveDeployPreparation> {
    if (this.prepareError) return { ok: false, reason: this.prepareError };
    const m = this.reservePools.get(p.mint);
    if (!m) return { ok: false, reason: "pool tidak ada" };
    const swapIn = p.deployQuote / 2n;
    const expected = swapIn * this.rate;
    const minOut = (expected * BigInt(10_000 - p.slippageBps)) / 10_000n;
    return {
      ok: true,
      plan: {
        pool: m.pool,
        lpMint: m.lpMint,
        deployQuote: p.deployQuote,
        swapIn,
        swapExpectedOut: expected,
        swapMinOut: minOut,
        lpAmount: 1_000n,
        maxQuote: p.deployQuote - swapIn,
        maxToken: minOut,
        priceImpactBps: this.priceImpactBps,
      },
    };
  }
  async buildReserveFund(p: {
    tokenMint: string;
    quoteMint: string;
    amount: bigint;
    createAccount: boolean;
  }) {
    return this.built({
      kind: "reserve_fund",
      tokenMint: p.tokenMint,
      quoteMint: p.quoteMint,
      amount: p.amount.toString(),
      create: p.createAccount,
    });
  }
  async buildReserveDeploy(p: {
    tokenMint: string;
    pair: PairConfig;
    plan: ReserveDeployPlanFields;
    createTokenAccount: boolean;
  }) {
    return this.built({
      kind: "reserve_deploy",
      tokenMint: p.tokenMint,
      quoteMint: p.pair.mint,
      swapIn: p.plan.swapIn.toString(),
      swapMinOut: p.plan.swapMinOut.toString(),
      lpAmount: p.plan.lpAmount.toString(),
      maxQuote: p.plan.maxQuote.toString(),
      createToken: p.createTokenAccount,
    });
  }
  async inspectReserveDeploy(signature: string) {
    return this.proofs.get(signature) ?? null;
  }

  /** "Mengeksekusi" transaksi bertanda tangan: efek saldo + status confirmed. */
  execute(signedTx: string) {
    const { signature, tx } = dec<{ signature: string; tx: FakeTx }>(signedTx);
    if (this.statuses.has(signature)) return; // signature sama tidak bisa mendarat dua kali
    this.executed.push(tx);
    const deltas: LandedTx["tokenDeltas"] = [];
    const move = (account: string, mint: string, delta: bigint) => {
      this.add(account, delta);
      deltas.push({ account, owner: this.master, mint, delta });
    };
    let err: unknown = null;
    if (tx.kind === "claim_curve") {
      const amount = this.curveVaults.get(tx.quoteMint) ?? 0n;
      this.curveVaults.set(tx.quoteMint, 0n);
      move(this.ata(tx.quoteMint), tx.quoteMint, amount);
    } else if (tx.kind === "claim_cpmm") {
      const p = this.pools.get(tx.pool)!;
      move(this.ata(p.mintA), p.mintA, p.feesA);
      move(this.ata(p.mintB), p.mintB, p.feesB);
      this.pools.set(tx.pool, { ...p, feesA: 0n, feesB: 0n });
    } else if (tx.kind === "buyback") {
      const amountIn = BigInt(tx.amountIn);
      const out = (amountIn * this.rate * (10_000n - this.executionShortfallBps)) / 10_000n;
      if (out < BigInt(tx.minOut)) {
        err = { InstructionError: [2, { Custom: 6005 }] }; // ExceededSlippage
      } else {
        move(this.ata(tx.quoteMint), tx.quoteMint, -amountIn);
        move(this.ata(tx.mint), tx.mint, out);
      }
    } else if (tx.kind === "burn") {
      move(this.ata(tx.mint), tx.mint, -BigInt(tx.amount));
    } else if (tx.kind === "reserve_fund") {
      const v = this.vault(tx.tokenMint, tx.quoteMint);
      this.existing.add(v.quoteAccount);
      move(this.ata(tx.quoteMint), tx.quoteMint, -BigInt(tx.amount));
      move(v.quoteAccount, tx.quoteMint, BigInt(tx.amount));
    } else {
      const v = this.vault(tx.tokenMint, tx.quoteMint);
      const out = BigInt(tx.swapIn) * this.rate;
      if (out < BigInt(tx.swapMinOut)) {
        err = { InstructionError: [3, { Custom: 6005 }] };
      } else {
        this.existing.add(v.tokenAccount);
        const quoteAdded = BigInt(tx.maxQuote) - 1n;
        const tokenAdded = BigInt(tx.swapMinOut) - 1n;
        move(v.quoteAccount, tx.quoteMint, -(BigInt(tx.swapIn) + quoteAdded));
        move(v.tokenAccount, tx.tokenMint, out - tokenAdded);
        this.proofs.set(signature, {
          failed: false,
          tokenBought: out,
          lpBurned: BigInt(tx.lpAmount) - this.lpBurnShortfall,
          lpLeft: this.lpBurnShortfall,
        });
      }
    }
    this.slot++;
    this.statuses.set(signature, { slot: this.slot, err, confirmationStatus: "confirmed" });
    this.landed.set(signature, {
      slot: this.slot,
      failed: err !== null,
      tokenDeltas: err ? [] : deltas,
    });
  }
}

/** Sender: mengeksekusi di chain palsu, atau menjatuhkan / crash sesuai skenario. */
export class FakeSender {
  sent = 0;
  /** Jumlah pengiriman berikutnya yang hilang di jaringan (tidak mendarat). */
  drop = 0;
  /** Jumlah pengiriman berikutnya yang gagal (worker mati setelah write-ahead, tx tak terkirim). */
  crash = 0;
  constructor(private readonly chain: FakeEconomicChain) {}
  async send(signedTx: string) {
    if (this.crash > 0) {
      this.crash--;
      throw new CrashError();
    }
    this.sent++;
    if (this.drop > 0) {
      this.drop--;
      return { signature: "", bundleId: null };
    }
    this.chain.execute(signedTx);
    return { signature: "", bundleId: null };
  }
}

/** Signer palsu: mencatat permintaan; bisa dipause atau menolak (simulasi gagal). */
export class FakeEconomicSigner {
  paused = false;
  requests: Array<{ purpose: string; opId?: string }> = [];
  nextError: SignerClientError | null = null;
  async deriveMint(): Promise<{ mint: string }> {
    throw new Error("tidak dipakai");
  }
  async sign(p: { purpose: string; jobId?: string; opId?: string; transaction: string }) {
    if (this.paused) throw new SignerClientError("paused", "signer sedang dipause", true);
    if (this.nextError) {
      const e = this.nextError;
      this.nextError = null;
      throw e;
    }
    this.requests.push({ purpose: p.purpose, ...(p.opId ? { opId: p.opId } : {}) });
    const signature = base58Encode(randomBytes(64));
    return { signature, transaction: enc({ signature, tx: dec<FakeTx>(p.transaction) }) };
  }
}
