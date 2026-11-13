/**
 * Blockchain, signer, dan sender palsu untuk test launch engine. FakeLedger meniru aturan yang
 * penting bagi jaminan "tidak ada launch ganda": satu mint hanya bisa dibuat sekali; transaksi
 * create kedua untuk mint yang sama GAGAL on-chain.
 */
import { createHash, randomBytes } from "node:crypto";
import { base58Encode, type PairConfig, type StonkFunLaunchPricing } from "@liftoff/shared";
import { RpcUnavailableError, type SendResult } from "@liftoff/solana";
import type {
  BuiltTx,
  LaunchChain,
  Sender,
  SignatureStatus,
  SignerClient,
  Verification,
} from "./ports";
import { SignerClientError } from "./ports";

interface FakeTx {
  kind: "create" | "transfer";
  mint?: string;
  to?: string;
  lamports?: string;
  lastValidBlockHeight: number;
  nonce: string;
}

const encode = (t: FakeTx) => Buffer.from(JSON.stringify(t)).toString("base64");
const decode = (b: string) =>
  JSON.parse(Buffer.from(b, "base64").toString()) as FakeTx & {
    signature?: string;
  };

export class FakeLedger implements LaunchChain {
  height = 1_000;
  /** Block height bertambah setiap kali dibaca (waktu berjalan). */
  heightStep = 20;
  validity = 150;
  mints = new Map<string, { pool: string; signature: string }>();
  statuses = new Map<string, SignatureStatus>();
  /** Berapa transaksi create yang benar-benar membuat mint (harus ≤ 1 per mint). */
  createsLanded = 0;
  createsFailedOnchain = 0;
  /** Berapa kali RPC berikutnya timeout. */
  failNextCalls = 0;
  /** Mint ada tetapi pool belum terbaca (RPC tertinggal). */
  hidePool = false;
  builds: Array<{ mint: string; pricing: StonkFunLaunchPricing }> = [];

  private maybeTimeout() {
    if (this.failNextCalls > 0) {
      this.failNextCalls--;
      throw new RpcUnavailableError("RPC tidak merespons (TimeoutError)");
    }
  }

  async buildLaunch(p: {
    mint: string;
    pair: PairConfig;
    pricing: StonkFunLaunchPricing;
  }): Promise<BuiltTx> {
    this.maybeTimeout();
    this.builds.push({ mint: p.mint, pricing: p.pricing });
    const lastValidBlockHeight = this.height + this.validity;
    return {
      transaction: encode({
        kind: "create",
        mint: p.mint,
        lastValidBlockHeight,
        nonce: randomBytes(4).toString("hex"),
      }),
      lastValidBlockHeight,
    };
  }

  async buildTransfer(p: { to: string; lamports: bigint }): Promise<BuiltTx> {
    this.maybeTimeout();
    const lastValidBlockHeight = this.height + this.validity;
    return {
      transaction: encode({
        kind: "transfer",
        to: p.to,
        lamports: p.lamports.toString(),
        lastValidBlockHeight,
        nonce: randomBytes(4).toString("hex"),
      }),
      lastValidBlockHeight,
    };
  }

  async verifyLaunch(p: { mint: string }): Promise<Verification> {
    this.maybeTimeout();
    const m = this.mints.get(p.mint);
    if (!m) return { ok: false, exists: false, reason: "mint & pool belum ada" };
    if (this.hidePool) return { ok: false, exists: true, reason: "pool belum ada" };
    return { ok: true, pool: m.pool };
  }

  async signatureStatuses(signatures: string[]) {
    this.maybeTimeout();
    return signatures.map((s) => this.statuses.get(s) ?? null);
  }

  async blockHeight() {
    this.maybeTimeout();
    this.height += this.heightStep;
    return this.height;
  }

  /** Menerapkan transaksi bertanda tangan ke ledger (dipanggil sender palsu). */
  land(signedBase64: string) {
    const t = decode(signedBase64);
    const signature = t.signature!;
    if (this.statuses.has(signature)) return; // signature yang sama hanya diproses sekali
    if (this.height > t.lastValidBlockHeight) return; // blockhash kedaluwarsa: tidak mendarat
    if (t.kind === "create") {
      if (this.mints.has(t.mint!)) {
        this.createsFailedOnchain++;
        this.statuses.set(signature, {
          slot: this.height,
          err: { InstructionError: [0, { Custom: 0 }] }, // account already in use
          confirmationStatus: "confirmed",
        });
        return;
      }
      this.createsLanded++;
      this.mints.set(t.mint!, { pool: `pool-${t.mint}`, signature });
    }
    this.statuses.set(signature, { slot: this.height, err: null, confirmationStatus: "confirmed" });
  }
}

export type SendBehavior = "land" | "drop" | "timeout_land" | "timeout_drop";

export class CrashError extends Error {
  constructor() {
    super("worker crash (simulasi)");
  }
}

export class FakeSender implements Sender {
  readonly mode = "rpc" as const;
  sent = 0;
  /** Perilaku per pengiriman berurutan; elemen terakhir dipakai seterusnya. */
  behaviors: SendBehavior[] = ["land"];
  constructor(private readonly ledger: FakeLedger) {}

  async tipAccount() {
    return null;
  }

  async send(signed: string): Promise<SendResult> {
    const b = this.behaviors[Math.min(this.sent, this.behaviors.length - 1)]!;
    this.sent++;
    const signature = decode(signed).signature!;
    if (b === "land" || b === "timeout_land") this.ledger.land(signed);
    if (b === "timeout_land" || b === "timeout_drop") {
      throw new RpcUnavailableError("RPC tidak merespons (TimeoutError)");
    }
    return { signature, bundleId: null };
  }
}

export class FakeSigner implements SignerClient {
  paused = false;
  signed = 0;
  /** Error berikutnya yang dilempar sign(). */
  nextError: SignerClientError | null = null;
  /** Lempar CrashError tepat setelah tanda tangan (worker mati sebelum mencatat). */
  crashAfterSign = false;

  async deriveMint(jobId: string) {
    return { mint: base58Encode(createHash("sha256").update(`mint:${jobId}`).digest()) };
  }

  async sign(p: { purpose: string; jobId?: string; opId?: string; transaction: string }) {
    if (this.paused) throw new SignerClientError("paused", "signer sedang dipause", true);
    if (this.nextError) {
      const e = this.nextError;
      this.nextError = null;
      throw e;
    }
    this.signed++;
    const signature = base58Encode(randomBytes(64));
    const t = { ...decode(p.transaction), signature };
    if (this.crashAfterSign) {
      this.crashAfterSign = false;
      throw new CrashError();
    }
    return { signature, transaction: Buffer.from(JSON.stringify(t)).toString("base64") };
  }
}
