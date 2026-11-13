// Operator: samakan platform fee DAN creator fee on-chain (Platform PDA LIFTOFF = StonkFun tiruan
// di devnet) dengan FEE_CONFIG (Spec §9–10).
//   pnpm --filter @liftoff/signer platform-fee           (dry-run: bangun + cek policy + simulasi)
//   pnpm --filter @liftoff/signer platform-fee --send    (tanda tangani & kirim)
// Dijalankan di apps/signer karena hanya proses ini yang boleh membaca key master. Perubahan
// berlaku SEKETIKA untuk semua koin (Tahap 1), jadi: emergency pause dihormati, allowlist ketat
// (checkPlatformFeeSyncPolicy: varian updateAll dengan semua bidang non-fee identik on-chain),
// simulasi sebelum sign, dan setiap langkah dicatat di audit_events.
import { userInfo } from "node:os";
import type { Prisma as PrismaTypes } from "@liftoff/db";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // opsional
}

const { Prisma, appDatabaseUrl, createPrismaClient } = await import("@liftoff/db");
const { bpsToRaydiumRate, FEE_CONFIG, assertValidFeeConfig } = await import("@liftoff/shared");
const { createConnection, inspectTransaction } = await import("@liftoff/solana");
const { buildPlatformFeeSyncIx, readPlatformConfig, updateAllArgsFrom } =
  await import("@liftoff/solana/launchlab");
const { TransactionMessage, VersionedTransaction } = await import("@solana/web3.js");
const { loadSignerConfig } = await import("./config");
const { loadMasterKeypair } = await import("./keys");
const { checkPlatformFeeSyncPolicy } = await import("./policy");
const { PAUSE_FLAG } = await import("./service");

const send = process.argv.includes("--send");
const actor = `cli:${userInfo().username}`;
const config = loadSignerConfig();
const db = createPrismaClient(appDatabaseUrl("signer"));
// Hanya untuk Platform PDA milik LIFTOFF (devnet). Di mainnet platform-nya milik StonkFun.
if (config.cluster !== "devnet") {
  throw new Error(`platform-fee hanya untuk devnet, bukan ${config.cluster}`);
}
const connection = createConnection(config.rpcUrl, {
  backupUrl: config.backupRpcUrl,
  cluster: config.cluster,
});
const log = (obj: Record<string, unknown>) => console.warn(JSON.stringify(obj));

async function audit(result: string, details: Record<string, unknown>, txSignature?: string) {
  await db.auditEvent.create({
    data: {
      actor,
      action: "signer.platform_fee",
      result,
      details: details as PrismaTypes.InputJsonValue,
      txSignature: txSignature ?? null,
    },
  });
}

try {
  assertValidFeeConfig(FEE_CONFIG);
  const target = {
    feeRate: bpsToRaydiumRate(FEE_CONFIG.platformFeeBps),
    creatorFeeRate: bpsToRaydiumRate(FEE_CONFIG.creatorFeeBps),
  };
  const onChain = await readPlatformConfig(connection, config.platform);
  const before = {
    feeRate: Number(onChain.feeRate.toString()),
    creatorFeeRate: Number(onChain.creatorFeeRate.toString()),
  };
  log({ platform: config.platform.platformId, onChain: before, target });
  if (before.feeRate === target.feeRate && before.creatorFeeRate === target.creatorFeeRate) {
    log({ result: "sudah sesuai FEE_CONFIG, tidak ada yang dikirim" });
  } else {
    const flag = await db.systemFlag.findUnique({ where: { key: PAUSE_FLAG } });
    if (config.envPaused || (flag?.value as { paused?: boolean } | null)?.paused) {
      throw new Error("signer sedang dipause (emergency pause); perubahan fee ditolak");
    }
    const master = loadMasterKeypair(config.keypairPath);
    if (master.publicKey.toBase58() !== config.platform.masterWallet) {
      throw new Error("keypair bukan master wallet platform");
    }
    // Bidang non-fee diambil dari state on-chain; policy membandingkan lagi dengan state ini.
    const current = updateAllArgsFrom(onChain, before);
    const latest = await connection.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: master.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: [buildPlatformFeeSyncIx(config.platform, updateAllArgsFrom(onChain, target))],
      }).compileToV0Message(),
    );
    const violations = checkPlatformFeeSyncPolicy({
      tx: inspectTransaction(tx),
      platform: config.platform,
      current,
      target,
    });
    if (violations.length) {
      await audit("rejected:policy_violation", { violations, from: before, to: target });
      throw new Error(`policy: ${violations.join("; ")}`);
    }
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      commitment: "confirmed",
    });
    if (sim.value.err) {
      await audit("rejected:simulation_failed", { err: sim.value.err, from: before, to: target });
      throw new Error(
        `simulasi gagal: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-4).join(" | ")}`,
      );
    }
    log({ simulation: "ok", unitsConsumed: sim.value.unitsConsumed ?? null, send });
    if (!send) {
      await audit("dry_run", { from: before, to: target });
    } else {
      tx.sign([master]);
      const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
      const conf = await connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        "confirmed",
      );
      if (conf.value.err) {
        await audit("failed", { err: conf.value.err, from: before, to: target }, signature);
        throw new Error(`transaksi gagal on-chain: ${signature}`);
      }
      const fee = BigInt(
        (await connection.getFeeForMessage(tx.message, "confirmed")).value ?? 5000,
      );
      await db.signerSpend.create({
        data: {
          purpose: "platform_fee_update",
          signature,
          lamports: new Prisma.Decimal(fee.toString()),
        },
      });
      const after = await readPlatformConfig(connection, config.platform);
      const verified = {
        feeRate: Number(after.feeRate.toString()),
        creatorFeeRate: Number(after.creatorFeeRate.toString()),
      };
      const unchanged =
        JSON.stringify(updateAllArgsFrom(after, before), (_k, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ) === JSON.stringify(current, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      await audit(
        "signed",
        { from: before, to: target, verified, otherFieldsUnchanged: unchanged },
        signature,
      );
      log({ signature, onChainAfter: verified, otherFieldsUnchanged: unchanged });
      if (
        verified.feeRate !== target.feeRate ||
        verified.creatorFeeRate !== target.creatorFeeRate
      ) {
        throw new Error("fee on-chain belum berubah setelah konfirmasi");
      }
      if (!unchanged) throw new Error("bidang non-fee Platform PDA berubah — periksa segera");
    }
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
