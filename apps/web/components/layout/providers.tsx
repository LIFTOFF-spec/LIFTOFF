"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import type { ReactNode } from "react";
import { getCluster } from "@/lib/format";
import { ToastProvider } from "../ui/toast";

import "@solana/wallet-adapter-react-ui/styles.css";

// Wallet untuk SIWS dan trade (Tahap 5): pengguna menandatangani transaksi trade sendiri.
const cluster = getCluster();
const endpoint = process.env.NEXT_PUBLIC_RPC_URL || clusterApiUrl(cluster);
// Wallet Standard (Phantom, Solflare, Backpack, …) terdeteksi otomatis.
const wallets: never[] = [];

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <ToastProvider>{children}</ToastProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
