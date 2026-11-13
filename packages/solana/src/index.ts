import {
  DEFAULT_SOLANA_CLUSTER,
  isPubkeyLike,
  isSolanaCluster,
  type SolanaCluster,
} from "@liftoff/shared";

// Wrapper RPC dan jalur kirim (RPC / Jito). Raydium LaunchLab ada di "@liftoff/solana/launchlab"
// agar API tidak ikut memuat SDK Raydium.

export type ClusterEnv = { readonly [name: string]: string | undefined };

/**
 * Syarat eksplisit menyalakan mainnet (Aturan #1, keputusan pemilik). Mengembalikan syarat yang
 * BELUM terpenuhi; kosong = boleh. Kecocokan pubkey dengan keypair dicek terpisah di signer
 * (`SignerService`), satu-satunya proses yang boleh membaca keypair.
 */
export function mainnetUnlockIssues(env: ClusterEnv): string[] {
  const issues: string[] = [];
  if (env.SOLANA_CLUSTER?.trim() !== "mainnet-beta") issues.push("SOLANA_CLUSTER=mainnet-beta");
  if (env.STONKFUN_MAINNET_ENABLED?.trim() !== "1") issues.push("STONKFUN_MAINNET_ENABLED=1");
  if (env.LIFTOFF_MAINNET_APPROVED?.trim() !== "ya") issues.push("LIFTOFF_MAINNET_APPROVED=ya");
  if (!isPubkeyLike(env.MASTER_WALLET_PUBKEY?.trim() ?? "")) {
    issues.push("MASTER_WALLET_PUBKEY terisi (pubkey, bukan private key)");
  }
  return issues;
}

/**
 * Membaca cluster dari env (default devnet). `mainnet-beta` hanya diterima bila SEMUA syarat
 * `mainnetUnlockIssues` terpenuhi; selain itu proses gagal start dengan pesan yang jelas.
 */
export function resolveCluster(env: ClusterEnv): SolanaCluster {
  const cluster = env.SOLANA_CLUSTER?.trim() || DEFAULT_SOLANA_CLUSTER;
  if (!isSolanaCluster(cluster)) {
    throw new Error(`SOLANA_CLUSTER tidak dikenal: ${cluster}`);
  }
  if (cluster === "mainnet-beta") {
    const issues = mainnetUnlockIssues(env);
    if (issues.length) {
      throw new Error(
        `mainnet-beta ditolak: syarat belum terpenuhi: ${issues.join(", ")} (docs/DEPLOY.md §12)`,
      );
    }
  }
  return cluster;
}

export * from "./connection";
export * from "./send";
export * from "./tx-inspect";
