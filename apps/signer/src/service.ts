/**
 * Signer service: satu-satunya pemegang key master wallet (Tahap 4).
 *
 * Urutan setiap permintaan tanda tangan:
 *   pause? → validasi job di DB → allowlist program/instruksi/penerima → simulasi (wajib sukses)
 *   → batas per transaksi & per 24 jam (di bawah advisory lock) → tanda tangan → audit_events.
 * Setiap permintaan, diterima atau ditolak, dicatat di audit_events.
 */
import { buybackBudgets, Prisma, refreshQuoteAssets, reserveCustody, type Db } from "@liftoff/db";
import {
  BPS_DENOMINATOR,
  pairsFor,
  perQuote,
  RESERVE_CONFIG,
  type SignerErrorCode,
  type SignerHealth,
  type SignerSignRequest,
  type SignerSignResponse,
} from "@liftoff/shared";
import {
  decodeTransaction,
  encodeTransaction,
  inspectTransaction,
  RpcUnavailableError,
  signatureOf,
  type InspectedTransaction,
} from "@liftoff/solana";
import { launchPoolAddress } from "@liftoff/solana/launchlab";
import { reserveVaultAddresses } from "@liftoff/solana/reserve";
import { associatedTokenAddress } from "@liftoff/solana/token-program";
import { migratedCpmmPoolAddress } from "@liftoff/solana/trade";
import type { AddressLookupTableAccount, Keypair, VersionedTransaction } from "@solana/web3.js";
import { scopeAllows, type SignerConfig, type SignerScope } from "./config";
import {
  checkBurnPolicy,
  checkBuybackPolicy,
  checkFeeClaimPolicy,
  type PolicyOp,
} from "./economic-policy";
import { deriveMintKeypair } from "./keys";
import { checkLaunchPolicy, checkRefundPolicy } from "./policy";
import { checkReserveDeployPolicy, checkReserveFundPolicy } from "./reserve-policy";

export const PAUSE_FLAG = "signer.paused";

export class SignerError extends Error {
  constructor(
    readonly code: SignerErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SignerError";
  }

  get httpStatus(): number {
    switch (this.code) {
      case "unauthorized":
        return 401;
      case "paused":
      case "rpc_unavailable":
        return 503;
      case "invalid_request":
        return 400;
      case "limit_exceeded":
        return 429;
      case "internal":
        return 500;
      default:
        return 422;
    }
  }
}

export interface SimulationResult {
  err: unknown;
  logs: string[];
  /** Saldo master wallet setelah simulasi (lamport). */
  postLamports: bigint | null;
  /** Saldo akun token yang diawasi setelah simulasi (urutan = argumen), 0 bila tertutup. */
  postTokenAmounts: bigint[];
  unitsConsumed: number | null;
}

/** Quote beli yang dihitung signer sendiri dari state pool on-chain (F2). */
export interface PoolQuote {
  route: "launchlab" | "cpmm";
  pool: string;
  /** Jumlah quote yang benar-benar terpakai (curve bisa memakai lebih sedikit saat selesai). */
  amountIn: bigint;
  expectedOut: bigint;
  /** Hanya CPMM: cadangan pool & suplai LP (rencana deployment reserve). */
  cpmm: { reserveToken: bigint; reserveQuote: bigint; lpSupply: bigint } | null;
}

/** Akun token milik master yang diawasi untuk batas aset (F3). */
interface WatchedAccount {
  account: string;
  mint: string;
}

/** Hasil validasi per tujuan: pelanggaran + akun aset yang diawasi + quote untuk cek silang. */
interface Prepared {
  violations: string[];
  watch: WatchedAccount[];
  quote?: { mint: string; quoteMint: string; amountIn: bigint; expectedOut: bigint };
}

/** Operasi RPC yang dibutuhkan signer (dipalsukan di test). */
export interface SignerChain {
  lookupTables(tx: VersionedTransaction): Promise<AddressLookupTableAccount[]>;
  balance(address: string): Promise<bigint>;
  /** Saldo akun token (0 bila belum ada). */
  tokenBalances(accounts: string[]): Promise<bigint[]>;
  /** Quote mint global config LaunchLab; null = akun bukan global config program LaunchLab. */
  launchConfigQuoteMint(configId: string): Promise<string | null>;
  fee(tx: VersionedTransaction): Promise<bigint>;
  simulate(
    tx: VersionedTransaction,
    watch: string,
    tokenAccounts?: string[],
  ): Promise<SimulationResult>;
  /** F2: quote beli token dari state pool on-chain (curve / CPMM), tanpa slippage. */
  quoteBuy(p: { mint: string; quoteMint: string; amountIn: bigint }): Promise<PoolQuote>;
  /** F8: chain yang sama lewat RPC cadangan untuk cek silang; null = tidak dikonfigurasi. */
  readonly backup?: SignerChain | null;
  /** cpConfigId Platform PDA on-chain (menurunkan pool CPMM hasil migrasi untuk policy). */
  platformCpConfigId(): Promise<string>;
  /** Signature sudah tercatat on-chain (berhasil atau gagal). */
  signatureLanded(signature: string): Promise<boolean>;
  /** Blockhash masih bisa dipakai transaksi (belum lewat lastValidBlockHeight). */
  blockhashValid(blockhash: string): Promise<boolean>;
  /** Program token pemilik mint (SPL klasik / Token-2022), dibaca on-chain. */
  mintProgram(mint: string): Promise<string>;
}

/** Tanda tangan lama tanpa blockhash tersimpan dianggap kedaluwarsa setelah ini. */
const LEGACY_SIGNATURE_TTL_MS = 5 * 60 * 1000;

export interface SignerDeps {
  db: Db;
  chain: SignerChain;
  master: Keypair;
  config: SignerConfig;
}

export class SignerService {
  constructor(private readonly deps: SignerDeps) {
    if (deps.master.publicKey.toBase58() !== deps.config.platform.masterWallet) {
      // Mainnet: pubkey dari MASTER_WALLET_PUBKEY. Tidak cocok = signer tidak boleh start.
      throw new Error(
        `keypair di SIGNER_KEYPAIR_PATH bukan master wallet platform untuk cluster ${deps.config.cluster} (cek MASTER_WALLET_PUBKEY)`,
      );
    }
  }

  private get db() {
    return this.deps.db;
  }

  async isPaused(): Promise<boolean> {
    if (this.deps.config.envPaused) return true;
    const flag = await this.db.systemFlag.findUnique({ where: { key: PAUSE_FLAG } });
    return (flag?.value as { paused?: boolean } | null)?.paused === true;
  }

  async health(): Promise<SignerHealth> {
    return {
      status: "ok",
      service: "signer",
      cluster: this.deps.config.cluster,
      paused: await this.isPaused(),
      masterWallet: this.deps.config.platform.masterWallet,
    };
  }

  private async audit(
    action: string,
    result: string,
    requestId: string | null,
    details: Record<string, unknown>,
    txSignature?: string,
  ) {
    await this.db.auditEvent.create({
      data: {
        actor: "signer",
        action,
        result,
        requestId,
        txSignature: txSignature ?? null,
        details: details as Prisma.InputJsonValue,
      },
    });
  }

  async setPaused(paused: boolean, actor: string, reason: string, requestId: string | null) {
    await this.db.systemFlag.upsert({
      where: { key: PAUSE_FLAG },
      create: { key: PAUSE_FLAG, value: { paused, reason }, updatedBy: actor },
      update: { value: { paused, reason }, updatedBy: actor },
    });
    await this.audit(paused ? "signer.pause" : "signer.resume", "ok", requestId, { actor, reason });
    return { paused: await this.isPaused() };
  }

  /** Pubkey mint untuk job (deterministik). Secret mint tetap di proses ini. */
  async deriveMint(
    jobId: string,
    requestId: string | null,
    scope: SignerScope = "all",
  ): Promise<{ mint: string }> {
    if (!scopeAllows(scope, "mint")) {
      await this.audit("signer.mint", "rejected:unauthorized", requestId, { jobId, scope });
      throw new SignerError(
        "unauthorized",
        `token cakupan ${scope} tidak boleh meminta mint`,
        false,
      );
    }
    const job = await this.db.launchJob.findUnique({ where: { id: jobId } });
    if (!job) {
      await this.audit("signer.mint", "rejected:invalid_request", requestId, { jobId });
      throw new SignerError("invalid_request", "launch job tidak ditemukan", false);
    }
    const mint = deriveMintKeypair(this.deps.master, jobId).publicKey.toBase58();
    // Pubkey mint tidak dicatat di audit (P5: dirahasiakan sampai live).
    await this.audit("signer.mint", "ok", requestId, { jobId });
    return { mint };
  }

  async sign(
    req: SignerSignRequest,
    requestId: string | null,
    scope: SignerScope = "all",
  ): Promise<SignerSignResponse> {
    const base = { jobId: req.jobId ?? null, opId: req.opId ?? null, purpose: req.purpose, scope };
    try {
      // F12: token worker launch tidak bisa meminta tujuan ekonomi, dan sebaliknya.
      if (!scopeAllows(scope, req.purpose)) {
        throw new SignerError(
          "unauthorized",
          `token cakupan ${scope} tidak boleh meminta tujuan ${req.purpose}`,
          false,
        );
      }
      const { assetOutflow, crossCheck, ...res } = await this.signInner(req);
      await this.audit(
        "signer.sign",
        "signed",
        requestId,
        { ...base, spendLamports: res.spendLamports, assetOutflow, crossCheck },
        res.signature,
      );
      return res;
    } catch (err) {
      const e =
        err instanceof SignerError
          ? err
          : err instanceof RpcUnavailableError
            ? new SignerError("rpc_unavailable", err.message, true)
            : new SignerError("internal", (err as Error).message, true);
      await this.audit("signer.sign", `rejected:${e.code}`, requestId, {
        ...base,
        message: e.message,
        details: e.details ?? null,
      }).catch(() => undefined);
      throw e;
    }
  }

  private async signInner(req: SignerSignRequest): Promise<SignResult> {
    const { config, master, chain } = this.deps;
    if (await this.isPaused()) {
      throw new SignerError("paused", "signer sedang dipause (emergency pause)", true);
    }
    // `perQuote` & `pairForMint` di bawah membaca katalog quote.
    await refreshQuoteAssets(this.db, config.cluster, { force: true });

    let tx: VersionedTransaction;
    try {
      tx = decodeTransaction(req.transaction);
    } catch {
      throw new SignerError("invalid_request", "transaksi tidak bisa di-decode", false);
    }
    const inspected = inspectTransaction(tx, await chain.lookupTables(tx));
    const masterKey = master.publicKey.toBase58();

    const signers: Keypair[] = [master];
    let violations: string[];
    let maxSpend = BigInt(config.policy.maxLamportsPerTx);

    if (req.purpose === "reserve_fund" || req.purpose === "reserve_deploy") {
      const prepared = await this.checkReserve(req.purpose, req.opId!, inspected);
      maxSpend = BigInt(config.policy.maxLamportsPerEconomicTx);
      return this.simulateAndSign(req, tx, signers, prepared, maxSpend);
    }
    if (req.purpose === "fee_claim" || req.purpose === "buyback" || req.purpose === "burn") {
      const prepared = await this.checkEconomic(req.purpose, req.opId!, inspected);
      maxSpend = BigInt(config.policy.maxLamportsPerEconomicTx);
      return this.simulateAndSign(req, tx, signers, prepared, maxSpend);
    }

    const job = await this.db.launchJob.findUnique({
      where: { id: req.jobId! },
      include: { token: true, deposit: true },
    });
    if (!job) throw new SignerError("invalid_request", "launch job tidak ditemukan", false);

    if (req.purpose === "launch") {
      if (job.status !== "submitting") {
        throw new SignerError(
          "policy_violation",
          `job berstatus ${job.status}, bukan submitting`,
          false,
        );
      }
      const { quoteMint, quoteConfigId } = job.token;
      // Pair di luar registri: global config wajib terbukti on-chain milik quote mint job ini.
      const known = pairsFor(config.cluster).some((p) => p.configId === quoteConfigId);
      if (!known && (await chain.launchConfigQuoteMint(quoteConfigId)) !== quoteMint) {
        throw new SignerError("policy_violation", "pair job tidak dikenal", false);
      }
      const mintKp = deriveMintKeypair(master, job.id);
      const mint = mintKp.publicKey.toBase58();
      if (job.mintAddress !== mint) {
        throw new SignerError(
          "policy_violation",
          "mint job tidak cocok dengan turunan signer",
          false,
        );
      }
      violations = checkLaunchPolicy({
        tx: inspected,
        platform: config.platform,
        mint,
        pool: launchPoolAddress(config.platform, mint, quoteMint),
        configId: quoteConfigId,
        maxTipLamports: config.maxTipLamports,
        // Satu-satunya tambahan: ATA quote master sendiri, tujuan fee yang diteruskan StonkFun.
        quoteAta:
          quoteMint === SOL_MINT
            ? null
            : {
                ata: associatedTokenAddress(
                  config.platform.masterWallet,
                  quoteMint,
                  await chain.mintProgram(quoteMint),
                ),
                mint: quoteMint,
              },
      });
      signers.push(mintKp);
    } else {
      const deposit = job.deposit;
      if (!deposit || deposit.status !== "refund_pending") {
        throw new SignerError("policy_violation", "tidak ada deposit yang menunggu refund", false);
      }
      const lamports = BigInt(deposit.lamports.toFixed(0));
      violations = checkRefundPolicy({
        tx: inspected,
        master: masterKey,
        recipient: deposit.payer,
        lamports,
      });
      // Refund boleh melebihi batas per transaksi launch, tapi tidak lebih dari deposit + fee.
      maxSpend = lamports + 100_000n;
    }
    return this.simulateAndSign(req, tx, signers, { violations, watch: [] }, maxSpend);
  }

  /**
   * Akun token milik master yang bisa berubah oleh operasi token ini (F3): ATA master token &
   * quote, serta akun kustodi reserve token itu. Keluaran aset = Σ sebelum − Σ sesudah per mint,
   * jadi pemindahan internal (reserve_fund: ATA → kustodi) tidak terhitung belanja.
   */
  private async watchedAccounts(tokenMint: string | null, assetMint: string) {
    const master = this.deps.config.platform.masterWallet;
    const quote = await this.deps.chain.mintProgram(assetMint);
    const watch: WatchedAccount[] = [
      { account: associatedTokenAddress(master, assetMint, quote), mint: assetMint },
    ];
    if (!tokenMint || tokenMint === assetMint) return watch;
    const token = await this.deps.chain.mintProgram(tokenMint);
    const vault = reserveVaultAddresses(master, tokenMint, { quote, token });
    watch.push(
      { account: associatedTokenAddress(master, tokenMint, token), mint: tokenMint },
      { account: vault.quoteAccount, mint: assetMint },
      { account: vault.tokenAccount, mint: tokenMint },
    );
    return watch;
  }

  /**
   * F2: quote beli dihitung signer sendiri dari state pool on-chain. Rute transaksi harus sama
   * dengan rute pool saat ini, dan `minOut` tidak boleh di bawah quote × (1 − batas slippage
   * signer). Batas diambil dari config signer, bukan dari baris DB.
   */
  private async ownQuote(p: {
    mint: string;
    quoteMint: string;
    amountIn: bigint;
    route: "launchlab" | "cpmm" | null;
  }) {
    const q = await this.deps.chain.quoteBuy(p);
    const violations: string[] = [];
    if (p.route && q.route !== p.route) {
      violations.push(`rute transaksi ${p.route} ≠ rute pool on-chain ${q.route}`);
    }
    return { q, violations };
  }

  /**
   * Validasi economic engine (Tahap 7): baris economic_ops harus `pending`, jenisnya cocok dengan
   * tujuan, token milik LIFTOFF, dan budget buyback/burn dihitung ulang dari ledger di sini —
   * worker tidak bisa meminta belanja melebihi alokasi buyback token itu yang sudah di-claim.
   */
  private async checkEconomic(
    purpose: "fee_claim" | "buyback" | "burn",
    opId: string,
    inspected: InspectedTransaction,
  ): Promise<Prepared> {
    const { config } = this.deps;
    const op = await this.db.economicOp.findUnique({ where: { id: opId } });
    if (!op) throw new SignerError("invalid_request", "operasi ekonomi tidak ditemukan", false);
    if (op.status !== "pending") {
      throw new SignerError(
        "policy_violation",
        `operasi berstatus ${op.status}, bukan pending`,
        false,
      );
    }
    const kinds: Record<typeof purpose, string[]> = {
      fee_claim: ["claim_curve", "claim_cpmm"],
      buyback: ["buyback"],
      burn: ["burn"],
    };
    if (!kinds[purpose].includes(op.kind)) {
      throw new SignerError("policy_violation", `operasi ${op.kind} bukan untuk ${purpose}`, false);
    }
    const dec = (d: Prisma.Decimal | null) => (d === null ? null : BigInt(d.toFixed(0)));
    const policyOp: PolicyOp = {
      kind: op.kind,
      tokenMint: op.tokenMint,
      assetMint: op.assetMint,
      target: op.target,
      amountIn: dec(op.amountIn),
      minOut: dec(op.minOut),
    };
    const token = op.tokenMint
      ? await this.db.token.findUnique({ where: { mint: op.tokenMint } })
      : null;
    if (op.tokenMint && (!token || token.launchStatus !== "live")) {
      throw new SignerError(
        "policy_violation",
        "token operasi bukan token LIFTOFF yang live",
        false,
      );
    }
    const pools = async () => {
      const launchPool = launchPoolAddress(config.platform, op.tokenMint!, token!.quoteMint);
      const cpConfig = await this.deps.chain.platformCpConfigId();
      return {
        launchPool,
        cpmmPool: migratedCpmmPoolAddress(
          config.platform.cpmmProgram,
          cpConfig,
          op.tokenMint!,
          token!.quoteMint,
        ),
      };
    };

    if (purpose === "fee_claim") {
      if (op.kind === "claim_cpmm") {
        const { cpmmPool } = await pools();
        if (op.target !== cpmmPool) {
          throw new SignerError(
            "policy_violation",
            "pool claim bukan pool hasil migrasi token",
            false,
          );
        }
      }
      const violations = checkFeeClaimPolicy({
        tx: inspected,
        platform: config.platform,
        cpmmProgram: config.platform.cpmmProgram,
        op: policyOp,
        quoteProgram: await this.deps.chain.mintProgram(op.assetMint),
      });
      return { violations, watch: await this.watchedAccounts(op.tokenMint, op.assetMint) };
    }
    if (purpose === "buyback") {
      if (op.assetMint !== token!.quoteMint) {
        throw new SignerError("policy_violation", "asset buyback bukan quote mint token", false);
      }
      await this.assertBudget(op.id, op.tokenMint!, op.assetMint, policyOp.amountIn ?? 0n);
      const { launchPool, cpmmPool } = await pools();
      const violations = checkBuybackPolicy({
        tx: inspected,
        platform: config.platform,
        cpmmProgram: config.platform.cpmmProgram,
        op: policyOp,
        launchPool,
        cpmmPool,
        programs: {
          token: await this.deps.chain.mintProgram(op.tokenMint!),
          quote: await this.deps.chain.mintProgram(op.assetMint),
        },
      });
      const watch = await this.watchedAccounts(op.tokenMint, op.assetMint);
      if (violations.length) return { violations, watch };
      // F2: allowlist lolos → bandingkan minOut dengan quote signer sendiri.
      const route = inspected.instructions.some(
        (ix) => ix.programId === config.platform.launchlabProgram,
      )
        ? "launchlab"
        : "cpmm";
      const amountIn = policyOp.amountIn!;
      const { q, violations: own } = await this.ownQuote({
        mint: op.tokenMint!,
        quoteMint: op.assetMint,
        amountIn,
        route,
      });
      const bps = config.policy.maxBuybackSlippageBps;
      const floor = applyBps(q.expectedOut, bps);
      if (policyOp.minOut! < floor) {
        own.push(
          `minOut ${policyOp.minOut} di bawah quote signer ${q.expectedOut} × (1 − ${bps} bps) = ${floor}`,
        );
      }
      return {
        violations: own,
        watch,
        quote: {
          mint: op.tokenMint!,
          quoteMint: op.assetMint,
          amountIn,
          expectedOut: q.expectedOut,
        },
      };
    }
    // burn: semua token hasil SATU buyback confirmed, atau budget berdenominasi token (fee CPMM
    // yang terpotong dalam token itu sendiri).
    if (op.parentOpId) {
      const parent = await this.db.economicOp.findUnique({ where: { id: op.parentOpId } });
      if (!parent || parent.kind !== "buyback" || parent.status !== "confirmed") {
        throw new SignerError(
          "policy_violation",
          "burn harus merujuk buyback yang confirmed",
          false,
        );
      }
      if (parent.tokenMint !== op.tokenMint || dec(parent.amountOut) !== policyOp.amountIn) {
        throw new SignerError("policy_violation", "jumlah burn ≠ token hasil buyback", false);
      }
    } else {
      if (op.assetMint !== op.tokenMint) {
        throw new SignerError(
          "policy_violation",
          "burn tanpa buyback hanya untuk budget token",
          false,
        );
      }
      await this.assertBudget(op.id, op.tokenMint!, op.assetMint, policyOp.amountIn ?? 0n);
    }
    const violations = checkBurnPolicy({
      tx: inspected,
      master: config.platform.masterWallet,
      op: policyOp,
      tokenProgram: await this.deps.chain.mintProgram(op.tokenMint!),
    });
    return { violations, watch: await this.watchedAccounts(op.tokenMint, op.assetMint) };
  }

  /**
   * Validasi Conviction Reserve (Tahap 8). Jumlah dihitung ulang dari ledger di sini: reserve_fund
   * ≤ reserve token itu yang masih di ATA master; reserve_deploy ≤ 25% saldo kustodi token itu
   * (Spec §12), hanya untuk token graduated dengan pool terverifikasi (Spec §14, Rule 7), tidak
   * saat token dipause, dan tidak dalam cooldown 24 jam sejak deployment terakhir token itu.
   */
  private async checkReserve(
    purpose: "reserve_fund" | "reserve_deploy",
    opId: string,
    inspected: InspectedTransaction,
  ): Promise<Prepared> {
    const { config } = this.deps;
    const master = config.platform.masterWallet;
    const op = await this.db.economicOp.findUnique({ where: { id: opId } });
    if (!op) throw new SignerError("invalid_request", "operasi ekonomi tidak ditemukan", false);
    if (op.status !== "pending") {
      throw new SignerError(
        "policy_violation",
        `operasi berstatus ${op.status}, bukan pending`,
        false,
      );
    }
    if (op.kind !== purpose) {
      throw new SignerError("policy_violation", `operasi ${op.kind} bukan untuk ${purpose}`, false);
    }
    const token = op.tokenMint
      ? await this.db.token.findUnique({ where: { mint: op.tokenMint } })
      : null;
    if (!token || token.launchStatus !== "live") {
      throw new SignerError(
        "policy_violation",
        "token operasi bukan token LIFTOFF yang live",
        false,
      );
    }
    if (op.assetMint !== token.quoteMint) {
      throw new SignerError("policy_violation", "asset reserve bukan quote mint token", false);
    }
    const dec = (d: Prisma.Decimal | null) => (d === null ? null : BigInt(d.toFixed(0)));
    const policyOp: PolicyOp = {
      kind: op.kind,
      tokenMint: op.tokenMint,
      assetMint: op.assetMint,
      target: op.target,
      amountIn: dec(op.amountIn),
      minOut: dec(op.minOut),
    };
    const amount = policyOp.amountIn ?? 0n;
    const [custody] = await reserveCustody(this.db, {
      tokenMint: token.mint!,
      excludeOpId: op.id,
    });
    const position = custody?.assetMint === op.assetMint ? custody : undefined;

    if (purpose === "reserve_fund") {
      const inMaster = position?.inMaster ?? 0n;
      if (amount > inMaster) {
        throw new SignerError(
          "policy_violation",
          `jumlah ${amount} melebihi reserve token ini di ATA master (${inMaster})`,
          false,
        );
      }
      const violations = checkReserveFundPolicy({
        tx: inspected,
        master,
        op: policyOp,
        programs: await this.reservePrograms(token.mint!, op.assetMint),
      });
      return { violations, watch: await this.watchedAccounts(token.mint!, op.assetMint) };
    }

    const override = await this.db.reserveConfigOverride.findUnique({
      where: { tokenMint: token.mint! },
    });
    if (override?.paused) {
      throw new SignerError("paused", "reserve token ini dipause (per-token pause)", true);
    }
    const graduation = await this.db.tokenGraduation.findUnique({
      where: { tokenMint: token.mint! },
    });
    const cpConfig = await this.deps.chain.platformCpConfigId();
    const cpmmPool = migratedCpmmPoolAddress(
      config.platform.cpmmProgram,
      cpConfig,
      token.mint!,
      token.quoteMint,
    );
    if (
      !graduation ||
      graduation.state !== "verified" ||
      !graduation.reserveMonitoringActive ||
      !graduation.addLiquiditySupported ||
      graduation.cpmmPool !== cpmmPool ||
      !graduation.lpMint
    ) {
      throw new SignerError(
        "policy_violation",
        "token belum graduate dengan pool CPMM terverifikasi kompatibel (Spec §14, Rule 7)",
        false,
      );
    }
    const inVault = position?.inVault ?? 0n;
    const cap = (inVault * BigInt(RESERVE_CONFIG.maxDeployPctPerRunBps)) / BigInt(BPS_DENOMINATOR);
    if (amount > cap) {
      throw new SignerError(
        "policy_violation",
        `batas deployment ${amount} melebihi ${RESERVE_CONFIG.maxDeployPctPerRunBps / 100}% saldo kustodi (${inVault})`,
        false,
      );
    }
    const since = new Date(Date.now() - RESERVE_CONFIG.cooldownSeconds * 1000);
    const recent = await this.db.economicOp.count({
      where: {
        kind: "reserve_deploy",
        tokenMint: token.mint!,
        id: { not: op.id },
        OR: [
          { status: { in: ["signed", "submitted"] } },
          { status: "confirmed", confirmedAt: { gte: since } },
        ],
      },
    });
    if (recent > 0) {
      throw new SignerError(
        "policy_violation",
        "cooldown: token ini sudah punya deployment reserve dalam 24 jam terakhir",
        false,
      );
    }
    const details = (op.details ?? {}) as Record<string, unknown>;
    const big = (k: string) => {
      const s = details[k];
      return typeof s === "string" && /^[0-9]+$/.test(s) ? BigInt(s) : 0n;
    };
    const plan = {
      swapIn: big("swapIn"),
      swapMinOut: big("swapMinOut"),
      lpAmount: big("lpAmount"),
      maxQuote: big("maxQuote"),
      maxToken: big("maxToken"),
    };
    const violations = checkReserveDeployPolicy({
      tx: inspected,
      master,
      cpmmProgram: config.platform.cpmmProgram,
      op: policyOp,
      plan,
      cpmmPool,
      lpMint: graduation.lpMint,
      programs: await this.reservePrograms(token.mint!, op.assetMint),
    });
    const watch = await this.watchedAccounts(token.mint!, op.assetMint);
    if (violations.length) return { violations, watch };
    const { q, violations: own } = await this.ownQuote({
      mint: token.mint!,
      quoteMint: op.assetMint,
      amountIn: plan.swapIn,
      route: "cpmm",
    });
    if (q.pool !== cpmmPool) own.push("pool quote signer bukan pool hasil migrasi token");
    own.push(...checkDeployAgainstQuote(plan, q, config.policy.maxReserveSlippageBps));
    return {
      violations: own,
      watch,
      quote: {
        mint: token.mint!,
        quoteMint: op.assetMint,
        amountIn: plan.swapIn,
        expectedOut: q.expectedOut,
      },
    };
  }

  private async reservePrograms(tokenMint: string, quoteMint: string) {
    return {
      token: await this.deps.chain.mintProgram(tokenMint),
      quote: await this.deps.chain.mintProgram(quoteMint),
    };
  }

  private async assertBudget(opId: string, tokenMint: string, assetMint: string, amount: bigint) {
    const rows = await buybackBudgets(this.db, { tokenMint, excludeOpId: opId });
    const row = rows.find((r) => r.assetMint === assetMint);
    const available = row?.available ?? 0n;
    if (amount > available) {
      throw new SignerError(
        "policy_violation",
        `jumlah ${amount} melebihi budget buyback token yang tersedia (${available})`,
        false,
      );
    }
  }

  private binding(req: SignerSignRequest) {
    return req.opId
      ? { opId: req.opId }
      : { purpose: req.purpose, jobId: req.jobId ?? null, opId: null };
  }

  /**
   * Menolak tanda tangan baru bila transaksi yang SUDAH ditandatangani untuk operasi yang sama
   * sudah mendarat (final) atau masih bisa mendarat (blockhash belum kedaluwarsa → retryable).
   * Mengembalikan jumlah tanda tangan lama, untuk dicek ulang di bawah kunci.
   */
  private async assertNoLiveSignature(binding: ReturnType<SignerService["binding"]>) {
    const prior = await this.db.signerSpend.findMany({
      where: binding,
      orderBy: { createdAt: "desc" },
    });
    for (const p of prior) {
      if (await this.deps.chain.signatureLanded(p.signature)) {
        throw new SignerError(
          "policy_violation",
          `operasi ini sudah punya transaksi on-chain (${p.signature}); tidak ditandatangani ulang`,
          false,
        );
      }
      const live = p.blockhash
        ? await this.deps.chain.blockhashValid(p.blockhash)
        : Date.now() - p.createdAt.getTime() < LEGACY_SIGNATURE_TTL_MS;
      if (live) {
        throw new SignerError(
          "policy_violation",
          "transaksi sebelumnya untuk operasi ini masih bisa mendarat; coba lagi setelah blockhash-nya kedaluwarsa",
          true,
        );
      }
    }
    return prior.length;
  }

  private async simulateAndSign(
    req: SignerSignRequest,
    tx: VersionedTransaction,
    signers: Keypair[],
    prepared: Prepared,
    maxSpend: bigint,
  ): Promise<SignResult> {
    const { config, master, chain } = this.deps;
    const masterKey = master.publicKey.toBase58();
    const { violations, watch } = prepared;
    if (violations.length) {
      throw new SignerError("policy_violation", violations[0]!, false, violations);
    }

    // Simulasi SEBELUM tanda tangan (sigVerify off, blockhash asli harus masih berlaku).
    const accounts = watch.map((w) => w.account);
    const [pre, preTokens, fee, sim] = await Promise.all([
      chain.balance(masterKey),
      chain.tokenBalances(accounts),
      chain.fee(tx),
      chain.simulate(tx, masterKey, accounts),
    ]);
    if (sim.err !== null) {
      const errLog = sim.logs.find((l) => /Error|failed/i.test(l)) ?? null;
      throw new SignerError(
        "simulation_failed",
        `simulasi gagal: ${JSON.stringify(sim.err)}`,
        isTransientSimError(sim.err),
        { err: sim.err, log: errLog },
      );
    }
    if (sim.postLamports === null) {
      throw new SignerError("rpc_unavailable", "simulasi tidak mengembalikan saldo master", true);
    }
    // Konservatif: selisih saldo + fee (fee bisa saja sudah termasuk; lebih baik over-count).
    const delta = pre - sim.postLamports;
    const spend = (delta > 0n ? delta : 0n) + fee;
    if (spend > maxSpend) {
      throw new SignerError(
        "limit_exceeded",
        `pengeluaran ${spend} lamport melebihi batas per transaksi ${maxSpend}`,
        false,
      );
    }
    // F3: keluaran aset per mint dari akun token milik master (diukur simulasi, bukan dari DB).
    const assets = assetOutflow(watch, preTokens, sim.postTokenAmounts);

    // F8: aksi besar dicek silang di RPC cadangan sebelum ditandatangani.
    const crossCheck = await this.crossCheck(prepared, pre, preTokens, spend, assets);

    // Satu transaksi hidup per operasi (Tahap 9): worker yang keliru/dibobol tidak bisa meminta
    // dua transaksi bertanda tangan untuk refund/buyback/deploy yang sama lalu mengirim keduanya.
    const binding = this.binding(req);
    const prior = await this.assertNoLiveSignature(binding);

    // Tanda tangan dulu di memori untuk mendapatkan signature, lalu catat pengeluaran di bawah
    // kunci global sebelum transaksi diberikan ke worker.
    tx.sign(signers);
    const signed = encodeTransaction(tx);
    const signature = signatureOf(signed);
    await this.db.$transaction(async (dbtx) => {
      await dbtx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('signer:spend', 0))`;
      // Permintaan paralel untuk operasi yang sama: hanya yang pertama lolos.
      if ((await dbtx.signerSpend.count({ where: binding })) !== prior) {
        throw new SignerError(
          "policy_violation",
          "operasi ini baru saja ditandatangani permintaan lain",
          true,
        );
      }
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const agg = await dbtx.signerSpend.aggregate({
        where: { createdAt: { gte: since } },
        _sum: { lamports: true },
        _count: true,
      });
      const used = BigInt((agg._sum.lamports ?? new Prisma.Decimal(0)).toFixed(0));
      if (agg._count + 1 > config.policy.maxTxPer24h) {
        throw new SignerError("limit_exceeded", "batas jumlah transaksi 24 jam tercapai", false);
      }
      if (used + spend > BigInt(config.policy.maxLamportsPer24h)) {
        throw new SignerError(
          "limit_exceeded",
          `batas pengeluaran 24 jam tercapai (${used} + ${spend} > ${config.policy.maxLamportsPer24h})`,
          false,
        );
      }
      if (Object.keys(assets).length) {
        const rows = await dbtx.$queryRaw<Array<{ mint: string; total: string }>>`
          SELECT a.key AS mint, SUM(a.value::numeric)::text AS total
          FROM "signer_spends" s, jsonb_each_text(s."assets") a
          WHERE s."createdAt" >= ${since}
          GROUP BY a.key`;
        const usedBy = new Map(rows.map((r) => [r.mint, BigInt(r.total)]));
        for (const [mint, raw] of Object.entries(assets)) {
          const cap = perQuote(config.policy.maxAssetOutflowRawPer24h, mint);
          const usedAsset = usedBy.get(mint) ?? 0n;
          if (usedAsset + BigInt(raw) > cap) {
            throw new SignerError(
              "limit_exceeded",
              `batas aset 24 jam ${mint} tercapai (${usedAsset} + ${raw} > ${cap})`,
              false,
            );
          }
        }
      }
      await dbtx.signerSpend.create({
        data: {
          purpose: req.purpose,
          jobId: req.jobId ?? null,
          opId: req.opId ?? null,
          blockhash: tx.message.recentBlockhash,
          signature,
          lamports: new Prisma.Decimal(spend.toString()),
          assets,
        },
      });
    });
    return {
      signature,
      transaction: signed,
      spendLamports: spend.toString(),
      assetOutflow: assets,
      crossCheck,
    };
  }

  /**
   * F8: bila keluaran aset (atau SOL) ≥ threshold config, saldo master, saldo akun token yang
   * diawasi, dan quote pool dibaca ulang di RPC cadangan. Beda → tolak (retryable): salah satu
   * RPC tertinggal atau berbohong. Tanpa RPC cadangan: dilewati, dicatat di audit.
   */
  private async crossCheck(
    prepared: Prepared,
    preLamports: bigint,
    preTokens: bigint[],
    spend: bigint,
    assets: Record<string, string>,
  ): Promise<CrossCheckResult | null> {
    const { config, chain } = this.deps;
    const thresholds = config.policy.crossCheckMinRaw;
    const large =
      spend >= perQuote(thresholds, SOL_MINT) ||
      Object.entries(assets).some(([mint, raw]) => BigInt(raw) >= perQuote(thresholds, mint));
    if (!large) return null;
    const backup = chain.backup;
    if (!backup) return { status: "skipped", reason: "RPC_BACKUP_URL tidak diisi" };
    const master = config.platform.masterWallet;
    const accounts = prepared.watch.map((w) => w.account);
    const q = prepared.quote;
    const [lamports, tokens, quote] = await Promise.all([
      backup.balance(master),
      backup.tokenBalances(accounts),
      q ? backup.quoteBuy({ mint: q.mint, quoteMint: q.quoteMint, amountIn: q.amountIn }) : null,
    ]).catch((err: unknown) => {
      if (err instanceof SignerError) throw err;
      throw new SignerError(
        "rpc_unavailable",
        `RPC cadangan tidak bisa dibaca untuk cek silang: ${(err as Error).message}`,
        true,
      );
    });
    const mismatch: string[] = [];
    if (lamports !== preLamports) mismatch.push(`saldo SOL master ${preLamports} ≠ ${lamports}`);
    tokens.forEach((t, i) => {
      if (t !== preTokens[i]) mismatch.push(`saldo ${accounts[i]} ${preTokens[i]} ≠ ${t}`);
    });
    if (quote && q) {
      const a = q.expectedOut;
      const diff = a > quote.expectedOut ? a - quote.expectedOut : quote.expectedOut - a;
      if (diff * BigInt(BPS_DENOMINATOR) > a * BigInt(config.policy.crossCheckToleranceBps)) {
        mismatch.push(`quote pool ${a} ≠ ${quote.expectedOut}`);
      }
    }
    if (mismatch.length) {
      throw new SignerError(
        "rpc_unavailable",
        `cek silang RPC gagal: ${mismatch[0]}`,
        true,
        mismatch,
      );
    }
    return { status: "ok", reason: null };
  }
}

const SOL_MINT = "So11111111111111111111111111111111111111112";

interface CrossCheckResult {
  status: "ok" | "skipped";
  reason: string | null;
}

/** Respons internal: response HTTP + data audit (keluaran aset, hasil cek silang). */
type SignResult = SignerSignResponse & {
  assetOutflow: Record<string, string>;
  crossCheck: CrossCheckResult | null;
};

/** amount × (1 − bps). */
export function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(BPS_DENOMINATOR - bps)) / BigInt(BPS_DENOMINATOR);
}

/** Keluaran bersih per mint (Σ sebelum − Σ sesudah, hanya yang positif), string desimal. */
export function assetOutflow(
  watch: Array<{ account: string; mint: string }>,
  pre: bigint[],
  post: bigint[],
): Record<string, string> {
  const net = new Map<string, bigint>();
  watch.forEach((w, i) => {
    net.set(w.mint, (net.get(w.mint) ?? 0n) + (pre[i] ?? 0n) - (post[i] ?? 0n));
  });
  const out: Record<string, string> = {};
  for (const [mint, v] of net) if (v > 0n) out[mint] = v.toString();
  return out;
}

/**
 * F2 untuk reserve_deploy: rencana di economic_ops dibandingkan dengan perhitungan signer dari
 * state pool CPMM saat ini (swap separuh quote, lalu deposit dua sisi):
 *  - swapMinOut ≥ quote swap signer × (1 − bps);
 *  - maxToken ≤ swapMinOut (deposit tidak boleh memakai token kustodi di luar hasil swap ini);
 *  - LP diminta ≥ LP yang dijamin batas deposit pada cadangan pool sesudah swap × (1 − bps),
 *    jadi maxQuote/maxToken tidak lebih longgar dari kebutuhan deposit + slippage signer.
 */
export function checkDeployAgainstQuote(
  plan: {
    swapIn: bigint;
    swapMinOut: bigint;
    lpAmount: bigint;
    maxQuote: bigint;
    maxToken: bigint;
  },
  q: PoolQuote,
  bps: number,
): string[] {
  if (q.route !== "cpmm" || !q.cpmm) return ["deployment reserve butuh pool CPMM"];
  const v: string[] = [];
  const floor = applyBps(q.expectedOut, bps);
  if (plan.swapMinOut < floor) {
    v.push(
      `swapMinOut ${plan.swapMinOut} di bawah quote signer ${q.expectedOut} × (1 − ${bps} bps) = ${floor}`,
    );
  }
  if (plan.maxToken > plan.swapMinOut) v.push("maxToken deposit melebihi minOut swap");
  const { reserveToken, reserveQuote, lpSupply } = q.cpmm;
  const tokenAfter = reserveToken - q.expectedOut;
  const quoteAfter = reserveQuote + plan.swapIn;
  if (tokenAfter <= 0n || lpSupply <= 0n) return [...v, "cadangan pool tidak cukup"];
  const byToken = (plan.maxToken * lpSupply) / tokenAfter;
  const byQuote = (plan.maxQuote * lpSupply) / quoteAfter;
  const minLp = applyBps(byToken < byQuote ? byToken : byQuote, bps);
  if (plan.lpAmount < minLp) {
    v.push(`LP ${plan.lpAmount} terlalu kecil untuk batas deposit (signer: ≥ ${minLp})`);
  }
  return v;
}

/** Error simulasi yang bisa hilang sendiri (blockhash, RPC tertinggal), bukan error program. */
export function isTransientSimError(err: unknown): boolean {
  const s = typeof err === "string" ? err : JSON.stringify(err);
  return /BlockhashNotFound|AccountNotFound|InsufficientFundsForFee|ProgramAccountNotFound/.test(s);
}
