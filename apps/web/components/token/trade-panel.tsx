"use client";

import {
  BPS_DENOMINATOR,
  FEE_CONFIG,
  TRADE_CONFIG,
  type BuiltTrade,
  type TradeErrorCode,
  type TradeFeeItem,
  type TradeQuote,
  type TradeReceipt,
  type TradeRoute,
  type TradeSide,
} from "@liftoff/shared";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { useEffect, useId, useRef, useState } from "react";
import { ApiRequestError, buildTrade, confirmTrade, quoteTrade } from "@/lib/api";
import { clusterCopy } from "@/lib/cluster";
import { explorerUrl, formatBps, formatNumber, getCluster, shortAddress } from "@/lib/format";
import { formatRate, formatUnits, parseUnits, toPlainUnits } from "@/lib/units";

/** Alokasi creator fee dari FEE_CONFIG (Aturan #10). */
const SPLIT_TEXT = `${formatBps(FEE_CONFIG.split.buybackBurn)} buyback & burn, ${formatBps(FEE_CONFIG.split.convictionReserve)} Conviction Reserve for this token`;
import { Tag } from "../ui/badges";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Button, cn } from "../ui/primitives";
import { useToast } from "../ui/toast";

const SLIPPAGE_PRESETS_BPS = [50, 100, 200];
const NATIVE_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAMS = [
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
];
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const ROUTE_LABEL: Record<TradeRoute, string> = {
  launchlab: "Bonding curve · Raydium LaunchLab",
  cpmm: "Raydium CPMM pool",
  jupiter: "Jupiter",
};

type Problem = { code: TradeErrorCode | string; message: string };
type Phase = "idle" | "building" | "review" | "signing" | "confirming" | "done";

/** ATA di kedua program token: token baru & sebagian quote memakai Token-2022. */
function atas(owner: PublicKey, mint: string) {
  return TOKEN_PROGRAMS.map(
    (program) =>
      PublicKey.findProgramAddressSync(
        [owner.toBuffer(), program.toBuffer(), new PublicKey(mint).toBuffer()],
        ATA_PROGRAM,
      )[0],
  );
}

async function fetchBalances(
  connection: Connection,
  owner: PublicKey,
  quoteMint: string,
  mint: string,
): Promise<{ quote: bigint; token: bigint }> {
  const tokenBal = async (m: string) => {
    const balances = await Promise.all(
      atas(owner, m).map(
        (account) =>
          connection
            .getTokenAccountBalance(account, "confirmed")
            .then((r) => BigInt(r.value.amount))
            .catch(() => 0n), // ATA belum ada
      ),
    );
    return balances.reduce((a, b) => a + b, 0n);
  };
  const [quote, token] = await Promise.all([
    quoteMint === NATIVE_MINT
      ? connection.getBalance(owner, "confirmed").then(BigInt)
      : tokenBal(quoteMint),
    tokenBal(mint),
  ]);
  return { quote, token };
}

function problemOf(err: unknown): Problem {
  if (err instanceof ApiRequestError) {
    return { code: err.body?.error.code ?? `http_${err.status}`, message: err.message };
  }
  const e = err as { name?: string; message?: string };
  const msg = e?.message ?? String(err);
  if (/reject|denied|cancel/i.test(`${e?.name} ${msg}`)) {
    return {
      code: "wallet_rejected",
      message: "You rejected the request in your wallet. Nothing was sent.",
    };
  }
  if (/block height exceeded|expired|blockhash not found/i.test(msg)) {
    return {
      code: "expired",
      message: "The transaction expired before it landed. Nothing was charged — try again.",
    };
  }
  if (/slippage/i.test(msg)) {
    return {
      code: "slippage_exceeded",
      message: "Price moved beyond your slippage limit. Try again or raise max slippage.",
    };
  }
  if (/insufficient/i.test(msg)) {
    return {
      code: "insufficient_balance",
      message: "Not enough balance for this trade plus network fees.",
    };
  }
  return { code: "unknown", message: msg || "Something went wrong." };
}

/**
 * Panel buy/sell (Tahap 5). API membangun transaksi unsigned + simulasi; wallet pengguna
 * menandatangani & mengirim. Fee yang ditampilkan berasal dari akun on-chain (bukan hardcode),
 * dan setelah trade dibandingkan dengan fee yang benar-benar terpotong (event on-chain).
 */
export function TradePanel({
  mint,
  ticker,
  quoteSymbol,
  quoteMint,
  quoteDecimals,
  tokenDecimals,
  graduated,
}: {
  mint: string;
  ticker: string;
  quoteSymbol: string;
  quoteMint: string;
  quoteDecimals: number;
  tokenDecimals: number;
  graduated: boolean;
}) {
  const [side, setSide] = useState<TradeSide>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(TRADE_CONFIG.defaultSlippageBps);
  const [customSlippage, setCustomSlippage] = useState("");
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [lastRoute, setLastRoute] = useState<TradeRoute | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [built, setBuilt] = useState<BuiltTrade | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [receipt, setReceipt] = useState<{ receipt: TradeReceipt; quoted: TradeQuote } | null>(
    null,
  );
  const [balances, setBalances] = useState<{ quote: bigint; token: bigint } | null>(null);
  const [balanceTick, setBalanceTick] = useState(0);
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  const { toast } = useToast();
  const amountId = useId();
  const slipId = useId();
  const quoteSeq = useRef(0);

  const inDecimals = side === "buy" ? quoteDecimals : tokenDecimals;
  const inSymbol = side === "buy" ? quoteSymbol : ticker;
  const outSymbol = side === "buy" ? ticker : quoteSymbol;
  const outDecimals = side === "buy" ? tokenDecimals : quoteDecimals;
  const raw = parseUnits(amount, inDecimals);
  const symbolOf = (m: string) =>
    m === mint ? ticker : m === quoteMint ? quoteSymbol : shortAddress(m);
  const decimalsOf = (m: string) => (m === mint ? tokenDecimals : quoteDecimals);

  // Saldo wallet (dimuat ulang setelah trade lewat balanceTick).
  useEffect(() => {
    if (!publicKey) return;
    let cancelled = false;
    void fetchBalances(connection, publicKey, quoteMint, mint).then((b) => {
      if (!cancelled) setBalances(b);
    });
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, quoteMint, mint, balanceTick]);

  // Quote ter-debounce dari API (fee & curve dibaca on-chain di server).
  useEffect(() => {
    const seq = ++quoteSeq.current;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (raw === null || raw <= 0n) {
        setQuote(null);
        setProblem(null);
        return;
      }
      setQuoting(true);
      try {
        const q = await quoteTrade(
          { mint, side, amountIn: raw.toString(), slippageBps },
          controller.signal,
        );
        if (seq !== quoteSeq.current) return;
        setQuote(q);
        setLastRoute(q.route);
        setProblem(null);
      } catch (err) {
        if (seq !== quoteSeq.current || controller.signal.aborted) return;
        setQuote(null);
        setProblem(problemOf(err));
      } finally {
        if (seq === quoteSeq.current) setQuoting(false);
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // raw adalah turunan dari amount + side; dibandingkan sebagai string agar stabil.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mint, side, raw?.toString(), slippageBps]);

  async function review() {
    if (!publicKey) {
      setVisible(true);
      return;
    }
    if (raw === null || raw <= 0n) return;
    setPhase("building");
    setProblem(null);
    try {
      const b = await buildTrade({
        mint,
        side,
        amountIn: raw.toString(),
        slippageBps,
        wallet: publicKey.toBase58(),
      });
      setQuote(b.quote);
      setLastRoute(b.quote.route);
      if (!b.simulation.ok) {
        setProblem({
          code: b.simulation.errorCode ?? "simulation_failed",
          message: b.simulation.message ?? "Simulation failed.",
        });
        setPhase("idle");
        return;
      }
      setBuilt(b);
      setPhase("review");
    } catch (err) {
      setProblem(problemOf(err));
      setPhase("idle");
    }
  }

  async function execute() {
    if (!built || !publicKey) return;
    setPhase("signing");
    try {
      const tx = VersionedTransaction.deserialize(
        Uint8Array.from(atob(built.transaction), (c) => c.charCodeAt(0)),
      );
      const signature = await sendTransaction(tx, connection, {
        preflightCommitment: "confirmed",
        maxRetries: 3,
      });
      setPhase("confirming");
      const res = await connection.confirmTransaction(
        {
          signature,
          blockhash: tx.message.recentBlockhash,
          lastValidBlockHeight: built.lastValidBlockHeight,
        },
        "confirmed",
      );
      if (res.value.err)
        throw new Error(`Transaction failed on-chain: ${JSON.stringify(res.value.err)}`);
      // Fee aktual dibaca API dari event on-chain; 409 = RPC API belum melihat transaksi.
      let rec: TradeReceipt | null = null;
      for (let i = 0; i < 10 && !rec; i++) {
        try {
          rec = await confirmTrade(mint, signature);
        } catch (err) {
          if (!(err instanceof ApiRequestError && err.status === 409)) throw err;
          await new Promise((r) => setTimeout(r, 1_500));
        }
      }
      if (!rec)
        throw new Error(`Trade landed (${signature}) but its receipt is not available yet.`);
      setReceipt({ receipt: rec, quoted: built.quote });
      setBuilt(null);
      setAmount("");
      setPhase("done");
      toast({ title: `${rec.side === "buy" ? "Bought" : "Sold"} $${ticker}`, tone: "success" });
      setBalanceTick((t) => t + 1);
    } catch (err) {
      setBuilt(null);
      setProblem(problemOf(err));
      setPhase("idle");
    }
  }

  const busy = phase === "building" || phase === "signing" || phase === "confirming";
  const valid = raw !== null && raw > 0n;
  const balanceIn = balances ? (side === "buy" ? balances.quote : balances.token) : null;
  // Rute terakhir yang terbaca dari chain lebih akurat daripada flag `graduated` dari DB
  // (DB diperbarui worker graduation setelah pool hasil migrasi terverifikasi).
  const route = quote?.route ?? lastRoute ?? (graduated ? "cpmm" : "launchlab");
  const routeLabel = ROUTE_LABEL[route];
  const highImpact = (quote?.priceImpactBps ?? 0) > 500;

  return (
    <section
      aria-label={`Trade ${ticker}`}
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border-2 border-ink bg-surface p-4 shadow-[var(--shadow-brutal)]"
    >
      <div
        className="grid grid-cols-2 gap-1 rounded-full border-2 border-ink bg-bg p-1"
        role="group"
        aria-label="Trade side"
      >
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={side === s}
            disabled={busy}
            onClick={() => {
              setSide(s);
              setAmount("");
              setQuote(null);
              setProblem(null);
            }}
            className={cn(
              "rounded-full py-2 text-sm font-semibold transition",
              side === s
                ? s === "buy"
                  ? "bg-success text-white"
                  : "bg-danger text-white"
                : "text-text-muted hover:text-text",
            )}
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={amountId} className="flex justify-between gap-2 text-xs text-text-muted">
          <span>Amount</span>
          <span className="truncate">{routeLabel}</span>
        </label>
        <div className="flex items-center rounded-lg border-2 border-line bg-surface focus-within:border-ink">
          <input
            id={amountId}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.0"
            value={amount}
            disabled={busy}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ""))}
            className="num w-full min-w-0 bg-transparent px-3 py-3 text-lg outline-none"
          />
          <span className="pr-3 font-mono text-sm text-text-muted">{inSymbol}</span>
        </div>
        {amount !== "" && raw === null && (
          <p className="text-xs text-danger">Enter a number with at most {inDecimals} decimals.</p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex gap-1.5">
            {side === "buy"
              ? // Nominal cepat hanya untuk SOL: nilai satu unit pair lain terlalu beragam untuk ditebak.
                (quoteMint === NATIVE_MINT ? ["0.01", "0.05", "0.1"] : []).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setAmount(v)}
                    className="rounded-full border border-line-strong px-2.5 py-1 font-mono text-xs text-text-muted hover:border-ink hover:text-text"
                  >
                    {v}
                  </button>
                ))
              : [25, 50, 100].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    disabled={!balances || balances.token === 0n}
                    onClick={() =>
                      balances &&
                      setAmount(toPlainUnits((balances.token * BigInt(pct)) / 100n, tokenDecimals))
                    }
                    className="rounded-full border border-line-strong px-2.5 py-1 font-mono text-xs text-text-muted hover:border-ink hover:text-text disabled:opacity-40"
                  >
                    {pct === 100 ? "Max" : `${pct}%`}
                  </button>
                ))}
          </div>
          {balanceIn !== null && (
            <span className="num text-[11px] text-text-subtle">
              Balance {formatUnits(balanceIn, inDecimals, side === "buy" ? 4 : 2)} {inSymbol}
            </span>
          )}
        </div>
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-xs text-text-muted">Max slippage</legend>
        <div className="flex flex-wrap gap-1.5">
          {SLIPPAGE_PRESETS_BPS.map((bps) => (
            <button
              key={bps}
              type="button"
              aria-pressed={slippageBps === bps && customSlippage === ""}
              onClick={() => {
                setSlippageBps(bps);
                setCustomSlippage("");
              }}
              className={cn(
                "rounded-full border px-2.5 py-1 font-mono text-xs",
                slippageBps === bps && customSlippage === ""
                  ? "border-ink bg-ink text-bg"
                  : "border-line-strong text-text-muted hover:border-ink hover:text-text",
              )}
            >
              {formatBps(bps)}
            </button>
          ))}
          <label htmlFor={slipId} className="sr-only">
            Custom slippage (%)
          </label>
          <input
            id={slipId}
            inputMode="decimal"
            placeholder="Custom %"
            value={customSlippage}
            onChange={(e) => {
              const text = e.target.value.replace(/[^0-9.]/g, "");
              setCustomSlippage(text);
              const pct = Number(text);
              const max = (TRADE_CONFIG.maxSlippageBps / BPS_DENOMINATOR) * 100;
              if (text && Number.isFinite(pct) && pct > 0 && pct <= max) {
                setSlippageBps(Math.max(1, Math.round((pct / 100) * BPS_DENOMINATOR)));
              }
            }}
            className="w-24 rounded-full border border-line-strong bg-surface px-2.5 py-1 font-mono text-xs outline-none focus:border-ink"
          />
        </div>
        {slippageBps > 500 && (
          <p className="text-[11px] text-warn">
            High slippage: you may receive much less than quoted.
          </p>
        )}
      </fieldset>

      <dl
        className="flex flex-col gap-1.5 rounded-xl border border-line bg-bg p-3 text-xs"
        aria-busy={quoting}
      >
        <Row label="You receive (est.)">
          {quote
            ? `${formatUnits(quote.expectedOut, outDecimals, side === "buy" ? 2 : 6)} ${outSymbol}`
            : "—"}
        </Row>
        <Row label={`Minimum received (${formatBps(slippageBps)} slippage)`}>
          {quote
            ? `${formatUnits(quote.minOut, outDecimals, side === "buy" ? 2 : 6)} ${outSymbol}`
            : "—"}
        </Row>
        <Row label="Price impact" className={highImpact ? "text-warn" : undefined}>
          {quote ? `${formatNumber(quote.priceImpactBps / 100, 2)}%` : "—"}
        </Row>
        <div className="mt-1 border-t border-line pt-1.5">
          <p className="mb-1 text-text-subtle">Fees you pay (read on-chain)</p>
          {quote ? (
            <FeeList fees={quote.fees} symbolOf={symbolOf} decimalsOf={decimalsOf} />
          ) : (
            <p className="text-text-subtle">Enter an amount to see the exact fees.</p>
          )}
        </div>
        {quote?.feeConfigMismatch?.map((m) => (
          <p key={m.kind} className="text-[11px] text-warn">
            On-chain {m.kind} fee is {formatRate(m.onChainRate)} (LIFTOFF config{" "}
            {formatBps(m.configuredBps)}). You pay the on-chain rate shown above.
          </p>
        ))}
        <p className="text-[11px] text-text-subtle">
          {quote?.route === "cpmm"
            ? `Graduated: no platform fee on the Raydium pool. The pool creator fee goes to LIFTOFF’s master wallet: ${SPLIT_TEXT}.`
            : `The creator fee goes to LIFTOFF’s master wallet: ${SPLIT_TEXT}. ${clusterCopy(getCluster()).tradePlatformFee}`}
        </p>
        {quote?.curve && quote.route === "launchlab" && (
          <p className="text-[11px] text-text-subtle">
            Curve {formatNumber(quote.curve.progressPct, 2)}% ·{" "}
            {formatUnits(quote.curve.raisedQuote, quoteDecimals, 4)} /{" "}
            {formatUnits(quote.curve.targetQuote, quoteDecimals, 4)} {quoteSymbol} raised
          </p>
        )}
        {quote?.warnings.map((w) => (
          <p key={w} className="text-[11px] text-warn">
            {w}
          </p>
        ))}
      </dl>

      {problem && (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/5 p-2 text-xs text-danger"
        >
          {problem.message}
        </p>
      )}

      <Button
        variant={side === "buy" ? "primary" : "danger"}
        className="w-full py-3"
        disabled={busy || (Boolean(publicKey) && (!valid || !quote))}
        onClick={review}
      >
        {!publicKey
          ? "Connect wallet"
          : phase === "building"
            ? "Simulating…"
            : phase === "signing"
              ? "Confirm in your wallet…"
              : phase === "confirming"
                ? "Confirming on-chain…"
                : `${side === "buy" ? "Buy" : "Sell"} $${ticker}`}
      </Button>
      <p className="text-center text-[11px] text-text-subtle">
        You sign with your own wallet. The transaction is simulated before you sign.
      </p>

      {receipt && <ReceiptCard data={receipt} symbolOf={symbolOf} decimalsOf={decimalsOf} />}

      <ConfirmDialog
        open={phase === "review" || phase === "signing"}
        title={`Confirm ${side === "buy" ? "buy" : "sell"}`}
        confirmLabel="Sign & send"
        busy={phase === "signing"}
        onConfirm={execute}
        onCancel={() => {
          setBuilt(null);
          setPhase("idle");
        }}
      >
        {built && (
          <dl className="flex flex-col gap-1.5 text-xs">
            <Row label="You pay">
              {formatUnits(built.quote.amountIn, inDecimals)} {inSymbol}
            </Row>
            <Row label="You receive (min)">
              {formatUnits(built.quote.minOut, outDecimals, side === "buy" ? 2 : 6)} {outSymbol}
            </Row>
            <Row label="Route">{ROUTE_LABEL[built.quote.route]}</Row>
            <div className="border-t border-line pt-1.5">
              <FeeList fees={built.quote.fees} symbolOf={symbolOf} decimalsOf={decimalsOf} />
            </div>
            <Row label="Network fee">{formatUnits(built.networkFeeLamports, 9)} SOL</Row>
            {built.rentLamports !== "0" && (
              <Row label="New token account rent">{formatUnits(built.rentLamports, 9)} SOL</Row>
            )}
            <p className="pt-1 text-success">
              ✓ Simulated successfully
              {built.simulation.unitsConsumed
                ? ` (${formatNumber(built.simulation.unitsConsumed, 0)} CU)`
                : ""}
            </p>
          </dl>
        )}
      </ConfirmDialog>
    </section>
  );
}

function Row({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-text-muted">{label}</dt>
      <dd className={cn("num text-right", className)}>{children}</dd>
    </div>
  );
}

function FeeList({
  fees,
  symbolOf,
  decimalsOf,
}: {
  fees: TradeFeeItem[];
  symbolOf: (mint: string) => string;
  decimalsOf: (mint: string) => number;
}) {
  const totals = new Map<string, bigint>();
  for (const f of fees) totals.set(f.mint, (totals.get(f.mint) ?? 0n) + BigInt(f.amount));
  return (
    <div className="flex flex-col gap-1">
      {fees.map((f) => (
        <Row key={f.kind} label={`${f.label}${f.rate ? ` (${formatRate(f.rate)})` : ""}`}>
          {formatUnits(f.amount, decimalsOf(f.mint))} {symbolOf(f.mint)}
        </Row>
      ))}
      {[...totals].map(([m, total]) => (
        <Row key={m} label="Total fees" className="font-semibold">
          {formatUnits(total, decimalsOf(m))} {symbolOf(m)}
        </Row>
      ))}
    </div>
  );
}

function ReceiptCard({
  data,
  symbolOf,
  decimalsOf,
}: {
  data: { receipt: TradeReceipt; quoted: TradeQuote };
  symbolOf: (mint: string) => string;
  decimalsOf: (mint: string) => number;
}) {
  const { receipt, quoted } = data;
  const quotedBy = new Map(quoted.fees.map((f) => [f.kind, f.amount]));
  const allMatch =
    receipt.fees.length === quoted.fees.length &&
    receipt.fees.every((f) => quotedBy.get(f.kind) === f.amount);
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border-2 border-ink bg-bg p-3 text-xs"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">Trade confirmed</span>
        <a
          href={explorerUrl("tx", receipt.signature)}
          target="_blank"
          rel="noreferrer"
          className="num underline decoration-line-strong underline-offset-2"
        >
          {shortAddress(receipt.signature, 6)} ↗
        </a>
      </div>
      <p className="text-text-muted">Fees actually charged on-chain (from the program event):</p>
      <div className="flex flex-col gap-1">
        {receipt.fees.map((f) => {
          const q = quotedBy.get(f.kind);
          return (
            <Row key={f.kind} label={f.label}>
              {formatUnits(f.amount, decimalsOf(f.mint))} {symbolOf(f.mint)}{" "}
              {q === f.amount ? (
                <span className="text-success">= quoted</span>
              ) : (
                <span className="text-warn">
                  quoted {q ? formatUnits(q, decimalsOf(f.mint)) : "—"}
                </span>
              )}
            </Row>
          );
        })}
      </div>
      {allMatch ? (
        <Tag tone="success">Charged fees match the quote exactly</Tag>
      ) : (
        <p className="text-[11px] text-text-subtle">
          Differences come from price moving between quote and execution (sell fees scale with
          output).
        </p>
      )}
      {receipt.referralLedgerEntry && (
        <p className="text-[11px] text-text-subtle">
          Referral fee recorded in the LIFTOFF fee ledger (source: referral).
        </p>
      )}
    </div>
  );
}
