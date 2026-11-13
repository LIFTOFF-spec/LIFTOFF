import Link from "next/link";
import { clusterCopy } from "@/lib/cluster";
import { getCluster } from "@/lib/format";
import { buttonClass } from "../ui/primitives";
import { Logo } from "./logo";

const X_URL = "https://x.com/LiftOffFun";

export function Footer() {
  return (
    <footer className="mt-16 border-t-2 border-ink">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:grid-cols-[1.5fr_1fr_1fr] sm:px-6">
        <div className="flex flex-col gap-3">
          <a
            href={X_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Follow LIFTOFF on X"
            className={buttonClass(
              "primary",
              "-mt-3.5 mb-3.5 self-start gap-1.5! px-3! py-1! text-xs!",
            )}
          >
            <svg viewBox="0 0 24 24" aria-hidden className="size-3" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            Follow us
          </a>
          <Logo />
          <p className="max-w-sm text-text-muted">Launch Fair. Build Stronger.</p>
          <p className="max-w-sm text-xs text-text-subtle">{clusterCopy(getCluster()).footer}</p>
        </div>
        <nav aria-label="Product">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
            Product
          </p>
          <ul className="flex flex-col gap-1.5 text-text-muted">
            <li>
              <Link className="hover:text-text" href="/explore">
                Explore
              </Link>
            </li>
            <li>
              <Link className="hover:text-text" href="/create">
                Launch a token
              </Link>
            </li>
            <li>
              <Link className="hover:text-text" href="/transparency">
                Transparency
              </Link>
            </li>
          </ul>
        </nav>
        <nav aria-label="Learn">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
            Learn
          </p>
          <ul className="flex flex-col gap-1.5 text-text-muted">
            <li>
              <Link className="hover:text-text" href="/how">
                How it works
              </Link>
            </li>
            <li>
              <Link className="hover:text-text" href="/conviction-reserve">
                Conviction Reserve
              </Link>
            </li>
            <li>
              <Link className="hover:text-text" href="/faq">
                FAQ
              </Link>
            </li>
            <li>
              <Link className="hover:text-text" href="/docs">
                Docs
              </Link>
            </li>
            <li>
              <Link className="hover:text-text" href="/how#fine-print">
                Fine print
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
