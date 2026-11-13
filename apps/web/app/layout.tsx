import type { Metadata, Viewport } from "next";
import { Figtree, Fira_Code, Ultra } from "next/font/google";
import type { ReactNode } from "react";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Providers } from "@/components/layout/providers";
import { ClusterBadge, MockBadge } from "@/components/ui/badges";
import { clusterLabel } from "@/lib/cluster";
import { getCluster } from "@/lib/format";
import "./globals.css";

// Ultra hanya untuk heading besar (.display); Figtree untuk UI; Fira Code untuk angka/alamat.
const display = Ultra({ subsets: ["latin"], weight: "400", variable: "--font-ultra" });
const sans = Figtree({ subsets: ["latin"], variable: "--font-figtree" });
const mono = Fira_Code({ subsets: ["latin"], variable: "--font-fira-code" });

export const metadata: Metadata = {
  title: { default: "LIFTOFF — Launch Fair. Build Stronger.", template: "%s · LIFTOFF" },
  description: "Launch Fair. Build Stronger.",
};

export const viewport: Viewport = {
  themeColor: "#fdfcf2",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const cluster = getCluster();
  const label = clusterLabel(cluster);
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="flex min-h-screen flex-col antialiased">
        <Providers>
          {/* Banner cluster (Tahap 11a): DEVNET di devnet, MAINNET BETA (uang asli) di mainnet. */}
          {cluster === "mainnet-beta" ? (
            <div
              role="note"
              className="border-b border-danger/30 bg-danger/5 px-4 py-1.5 text-center text-[11px] text-text"
            >
              <ClusterBadge cluster={cluster} className="mr-1.5 align-middle" />
              {label.notice}
            </div>
          ) : (
            <div className="border-b border-mock/20 bg-mock/5 px-4 py-1.5 text-center text-[11px] text-text-muted">
              <MockBadge className="mr-1.5 align-middle" />
              {label.notice}
            </div>
          )}
          <Navbar />
          <div className="flex-1">{children}</div>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
