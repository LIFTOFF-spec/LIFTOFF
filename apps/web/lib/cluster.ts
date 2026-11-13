import type { SolanaCluster } from "@liftoff/shared";

/**
 * Label cluster yang selalu terlihat (Tahap 11a): DEVNET di devnet, MAINNET BETA di mainnet.
 * Teks mainnet sengaja tidak menjanjikan apa pun: tidak sniper-proof, harga tidak dijamin, dan
 * LP hanya dianggap terkunci bila terbukti on-chain.
 */
export interface ClusterLabel {
  badge: string;
  tone: "devnet" | "beta";
  /** Penjelasan singkat untuk atribut title / pembaca layar. */
  title: string;
  /** Kalimat banner di atas setiap halaman. */
  notice: string;
}

/**
 * Teks website yang berbeda per cluster (Tahap 11b), satu tempat supaya bisa diuji: di mainnet
 * tidak boleh ada kata devnet/MOCK/faucet atau janji (sniper-proof, harga dijamin, LP terkunci).
 */
export interface ClusterCopy {
  footer: string;
  /** Kalimat tambahan tentang StonkFun di kartu dependency; null = tidak ada. */
  dependencyNote: string | null;
  faqStonkfun: string;
  faqPairs: string;
  faqSniper: string;
  /** Tambahan jawaban FAQ & How soal fee; null = tidak ada. */
  feeCaveat: string | null;
  howPairs: string;
  howSniperIntro: string;
  howSniperMeaning: string;
  howFinePrintIntro: string;
  howFinePrintBundle: string;
  /** Tag status FEE_CONFIG terverifikasi. */
  feeVerifiedTag: string;
  feePlatformOwner: string;
  tradePlatformFee: string;
  createPairsIntro: string;
  createPairsFootnote: string;
  createDependency: string;
  createSniper: string;
  launchSendPath: string;
  statVolumeDefinition: string;
  tokenDataSourcesTail: string;
  usdEstimateTitle: string;
  reserveDeployedDefinition: string;
  launchCostDefinition: string;
  reserveDeploymentStatus: string;
  feeIntakeIntro: string;
}

const LAUNCH_COST_BASE =
  "SOL the launch authority paid for creation costs. Creators reimburse this with the launch-cost payment they send before launching (refunded if a launch fails); no fee share is used for this.";

const MAINNET_COPY: ClusterCopy = {
  footer:
    "Public beta on Solana mainnet. Built on StonkFun and Raydium infrastructure. Market numbers are USD estimates at the current price of the pair asset, shown in the pair asset while that price cannot be verified. Not affiliated with StonkFun or Raydium. Not financial advice.",
  dependencyNote: null,
  faqStonkfun:
    "Yes. On mainnet, launches use StonkFun’s standard platform config on Raydium LaunchLab, and the active config and supported pairs are loaded live from StonkFun. Whether StonkFun lists a token is read from StonkFun and shown on that token’s page. LIFTOFF is not affiliated with StonkFun.",
  faqPairs:
    "The pair list is loaded live from StonkFun. A pair can be picked only when it is launchable, LaunchLab-ready and open on LIFTOFF; other pairs show the reason. Non-SOL pairs open after creator-fee forwarding is proven in a live test. Community-listed pairs carry a warning, so check the mint address.",
  faqSniper:
    "No. On mainnet the creation transaction goes through a private submission route where supported, and the mint address stays secret until the launch lands. That reduces exposure before execution, but does not prevent every sniping strategy.",
  feeCaveat:
    "During the mainnet beta, StonkFun forwards creator fees to the master wallet and the real amounts are still being measured. Only amounts that actually arrived are recorded, on the Transparency page.",
  howPairs:
    "Availability is loaded live from StonkFun. A pair can be picked only when it is launchable, LaunchLab-ready and open on LIFTOFF; non-SOL pairs open after creator-fee forwarding is proven in a live test.",
  howSniperIntro:
    "On mainnet, the creation transaction is sent as a private bundle (Jito) with a tip, not through the public mempool, and the mint address is not published before the transaction lands.",
  howSniperMeaning:
    "What this means: less exposure before the launch lands, nothing more. It is not a guarantee about who buys first. After creation, the token trades normally — anyone, bots included, can buy. This is not sniper-proof.",
  howFinePrintIntro:
    "LIFTOFF on Solana mainnet is in public beta: launches, trades and fees use real funds and cannot be undone. Market numbers are shown in USD, estimated at the current price of the pair asset, not promises; while that price cannot be verified they are shown in the pair asset instead.",
  howFinePrintBundle:
    "The private bundle only limits exposure before the launch lands. After that, anyone — bots included — can trade as usual.",
  feeVerifiedTag: "Being measured on mainnet",
  feePlatformOwner: "StonkFun platform config",
  tradePlatformFee: "The platform fee belongs to the StonkFun platform config.",
  createPairsIntro:
    "Pick the asset your token trades against. The list is loaded live from StonkFun; a pair can be picked only when it is launchable, LaunchLab-ready and open on LIFTOFF. Symbols can repeat, so check the mint.",
  createPairsFootnote:
    "The graduation target and availability come from StonkFun and the pair’s on-chain config. If the config changes before your launch is sent, the launch stops safely.",
  createDependency:
    "LIFTOFF depends on StonkFun and Raydium. This launch uses real funds and cannot be undone.",
  createSniper:
    "The creation transaction is sent as a private bundle, which limits exposure before it lands. After that, the token trades normally and anyone can buy. This is not sniper-proof.",
  launchSendPath: "sent as a private Jito bundle",
  statVolumeDefinition:
    "Sum of all on-chain trades in LIFTOFF tokens (also trades made outside LIFTOFF), read by the indexer. Shown per pair asset below; the USD figure is an estimate at the current price of each pair asset.",
  tokenDataSourcesTail:
    "USD equivalents are estimates at the current price of the pair asset (StonkFun, cross-checked with Jupiter) and show n/a while that price cannot be verified.",
  usdEstimateTitle:
    "Estimated USD equivalent at the current price of the pair asset (StonkFun, cross-checked with Jupiter)",
  reserveDeployedDefinition:
    "Reserve added to graduated pools, from confirmed deployments. Shown in the pair asset; the USD figure is an estimate at the current price of each pair asset.",
  launchCostDefinition: `${LAUNCH_COST_BASE} The total appears here once real mainnet costs are measured.`,
  reserveDeploymentStatus:
    "Automated deployment runs only while the price of the pair asset is verified (StonkFun, cross-checked with Jupiter). Otherwise the reserve keeps accumulating in custody and nothing is deployed. Each deployment swaps part of the reserve, adds liquidity to the token’s own Raydium CPMM pool and burns the LP tokens in the same transaction.",
  feeIntakeIntro:
    "StonkFun forwards creator fees to the master wallet, which all LIFTOFF tokens share; fees from graduated Raydium pools are claimed. Each forwarded amount can be checked on-chain, but its split between tokens is “estimated” from each token’s trading volume. “Verified” means an amount matches the per-token ledger exactly. Once enabled, 80% buys back that same token and every bought token is burned; automatic buybacks are not running yet.",
};

export function clusterCopy(cluster: SolanaCluster): ClusterCopy {
  if (cluster === "mainnet-beta") return MAINNET_COPY;
  return {
    footer: `Early build (${cluster}). Built on StonkFun and Raydium infrastructure (StonkFun is emulated on devnet). Numbers marked MOCK are sample data or estimates. Not affiliated with StonkFun or Raydium. Not financial advice.`,
    dependencyNote:
      " StonkFun only exists on mainnet, so on devnet LIFTOFF’s own platform config stands in for it; nothing here is a StonkFun launch yet.",
    faqStonkfun: `Not on ${cluster}. StonkFun only exists on mainnet and has no public API we could integrate yet, so on devnet LIFTOFF’s own platform config emulates it: the active config and supported pairs are read from the chain. Nothing launched on devnet is a StonkFun token.`,
    faqPairs:
      "The list is loaded live from StonkFun’s supported pairs (emulated on devnet from on-chain Raydium LaunchLab configs). A pair is only offered when it is launchable and LaunchLab-ready. Tokenized stocks such as SPYx, NVDAx, TSLAx and QQQx appear only when a config exists for them.",
    faqSniper:
      "No. On mainnet the creation transaction goes through a private submission route where supported, and the mint address stays secret until the launch lands. That reduces exposure before execution, but does not prevent every sniping strategy. On devnet there is no private route.",
    feeCaveat: null,
    howPairs:
      "Each token trades against the pair the creator picks. The list is loaded live from StonkFun’s supported pairs (emulated on devnet from on-chain Raydium configs), and a pair is only offered when it is both launchable and LaunchLab-ready.",
    howSniperIntro:
      "On mainnet, the creation transaction is sent as a private bundle (Jito) with a tip, not through the public mempool, and the mint address is not published before the transaction lands. Devnet has no Jito, so devnet launches go through a regular RPC — only the secret mint address applies there.",
    howSniperMeaning:
      "What this means on mainnet: other transactions are kept out of the token’s creation block. On devnet there is no such guarantee. After the creation block, the token trades normally — anyone, bots included, can buy. This is not sniper-proof.",
    howFinePrintIntro:
      "LIFTOFF is a devnet prototype. StonkFun only exists on mainnet, so on devnet LIFTOFF’s own platform config stands in for it. Numbers marked MOCK are sample data or estimates.",
    howFinePrintBundle:
      "The private bundle (mainnet only) only keeps other transactions out of the creation block. After that, anyone — bots included — can trade as usual.",
    feeVerifiedTag: "Verified on devnet",
    feePlatformOwner: "StonkFun platform config (emulated by LIFTOFF on devnet)",
    tradePlatformFee:
      "The platform fee belongs to the StonkFun platform config (emulated on devnet).",
    createPairsIntro: `Your token trades against the pair you pick. Pairs are loaded live from StonkFun’s supported pairs (emulated on ${cluster}); only launchable, LaunchLab-ready pairs can be picked.`,
    createPairsFootnote:
      "Curve values come from the pair’s on-chain config; USD values use assumed pair prices (estimated), because devnet has no price feed. If the config changes before your launch is sent, the launch stops safely.",
    createDependency: `LIFTOFF depends on StonkFun and Raydium. On ${cluster}, StonkFun is emulated by LIFTOFF’s own platform config.`,
    createSniper:
      "On devnet there are no private bundles: the creation transaction goes through a regular RPC. The mint address stays secret until the launch lands. This is not sniper-proof.",
    launchSendPath: "sent through a regular RPC (devnet has no private bundles)",
    statVolumeDefinition:
      "Sum of all on-chain trades in LIFTOFF tokens (also trades made outside LIFTOFF), read by the indexer. USD uses an assumed pair price; devnet has no price feed.",
    tokenDataSourcesTail:
      "MOCK = USD equivalents at an assumed pair price, because devnet has no price feed.",
    usdEstimateTitle: "USD equivalent at an assumed pair price (devnet has no price feed)",
    reserveDeployedDefinition:
      "Reserve added to graduated pools, from confirmed deployments (USD at the pair’s assumed price).",
    launchCostDefinition: `${LAUNCH_COST_BASE} Estimated from the devnet cost report.`,
    reserveDeploymentStatus:
      "Automated deployment: live on devnet. Each deployment swaps part of the reserve, adds liquidity to the token’s own Raydium CPMM pool and burns the LP tokens in the same transaction.",
    feeIntakeIntro:
      "The master wallet claims creator fees from the LaunchLab creator vault and from graduated Raydium pools, then reconciles each claim against the per-token ledger: “verified” means the claimed amount matches the ledger exactly; “estimated” means a difference was corrected pro-rata. 80% then buys back that same token, and every bought token is burned.",
  };
}

export function clusterLabel(cluster: SolanaCluster): ClusterLabel {
  if (cluster === "mainnet-beta") {
    return {
      badge: "MAINNET BETA",
      tone: "beta",
      title: "LIFTOFF on Solana mainnet is in public beta",
      notice:
        "Mainnet beta — launches, trades and fees use real funds and cannot be undone. LIFTOFF is still being tested: launches are not sniper-proof, prices and graduation are not guaranteed, and liquidity counts as locked only when the lock is shown on-chain. Only use what you can afford to lose.",
    };
  }
  const name = cluster === "testnet" ? "TESTNET" : "DEVNET";
  return {
    badge: name,
    tone: "devnet",
    title: `${name.toLowerCase()} build: test tokens only, no real value`,
    notice: `${cluster} build — prices, volume, holders and trades are read on-chain by the LIFTOFF indexer. Devnet has no price feed, so USD amounts marked MOCK use an assumed pair price. Trades are real ${cluster} transactions signed by your wallet, with test tokens of no value.`,
  };
}
