export const SOLANA_CLUSTERS = ["devnet", "testnet", "mainnet-beta"] as const;
export type SolanaCluster = (typeof SOLANA_CLUSTERS)[number];

export const DEFAULT_SOLANA_CLUSTER: SolanaCluster = "devnet";

/** Hash genesis (publik) untuk memastikan RPC benar-benar melayani cluster yang dimaksud. */
export const GENESIS_HASH: Record<SolanaCluster, string> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
};

export function isSolanaCluster(value: string): value is SolanaCluster {
  return (SOLANA_CLUSTERS as readonly string[]).includes(value);
}
