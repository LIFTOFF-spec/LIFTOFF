"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useSession } from "@/lib/auth";
import { getCluster } from "@/lib/format";
import { ClusterBadge } from "../ui/badges";
import { cn } from "../ui/primitives";
import { WalletButton, XLinkButton } from "./account-buttons";
import { Logo } from "./logo";

// Halaman Spec §17.
const NAV = [
  { href: "/explore", label: "Explore" },
  { href: "/create", label: "Create" },
  { href: "/how", label: "How it works" },
  { href: "/conviction-reserve", label: "Reserve" },
  { href: "/transparency", label: "Transparency" },
  { href: "/faq", label: "FAQ" },
  { href: "/docs", label: "Docs" },
];

export function Navbar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { user } = useSession();
  const nav = user?.isAdmin ? [...NAV, { href: "/admin", label: "Admin" }] : NAV;

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <header className="sticky top-0 z-30 border-b-2 border-ink bg-bg/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" aria-label="LIFTOFF home" className="shrink-0">
          <span className="sm:hidden">
            <Logo withText={false} />
          </span>
          <span className="hidden sm:block">
            <Logo />
          </span>
        </Link>
        {/* Label cluster cukup di banner atas saat ruang sempit: layar kecil (tombol menu) dan
            layar lg sebelum xl (menu lengkap). */}
        <span className="hidden shrink-0 sm:inline-flex lg:hidden xl:inline-flex">
          <ClusterBadge cluster={getCluster()} />
        </span>
        <nav aria-label="Main navigation" className="ml-2 hidden lg:block xl:ml-4">
          <ul className="flex gap-1">
            {nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive(item.href) ? "page" : undefined}
                  className={cn(
                    "whitespace-nowrap rounded-full px-2.5 py-1.5 text-sm font-medium transition xl:px-3",
                    isActive(item.href)
                      ? "bg-ink text-bg"
                      : "text-text-muted hover:bg-surface-2 hover:text-text",
                  )}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden sm:block">
            <XLinkButton compact />
          </span>
          <WalletButton />
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex size-9 items-center justify-center rounded-full border-2 border-ink lg:hidden"
          >
            <svg
              viewBox="0 0 20 20"
              aria-hidden
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              {open ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3 6h14M3 10h14M3 14h14" />}
            </svg>
          </button>
        </div>
      </div>
      {open && (
        <nav
          id="mobile-nav"
          aria-label="Mobile navigation"
          className="border-t border-line bg-bg lg:hidden"
        >
          <ul className="mx-auto flex max-w-6xl flex-col px-4 py-2">
            {nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  aria-current={isActive(item.href) ? "page" : undefined}
                  className={cn(
                    "block rounded-lg px-2 py-2.5 text-sm",
                    isActive(item.href) ? "font-semibold text-text" : "text-text-muted",
                  )}
                >
                  {item.label}
                </Link>
              </li>
            ))}
            <li className="py-2 sm:hidden">
              <XLinkButton className="w-full" />
            </li>
          </ul>
        </nav>
      )}
    </header>
  );
}
