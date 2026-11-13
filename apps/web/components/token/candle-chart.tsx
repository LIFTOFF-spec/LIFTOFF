"use client";

import { CANDLE_INTERVALS, type CandleInterval, type CandleSeries } from "@liftoff/shared";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { getCandles } from "@/lib/api";
import {
  formatAmount,
  formatChartPrice,
  formatDateTime,
  formatPrice,
  formatUsd,
} from "@/lib/format";
import { StatusBadge } from "../ui/badges";
import { cn } from "../ui/primitives";

const REFRESH_MS = 15_000;
// Warna chart gelap: warna success/danger situs terlalu redup di atas hitam.
const CHART = {
  background: "#111111",
  text: "#b8b4a8",
  grid: "#2a2a2a",
  border: "#3a3a3a",
  up: "#22c55e",
  down: "#ef4444",
};

type CandleApi = ISeriesApi<"Candlestick">;
type ChartMetric = "price" | "mcap";

const CHART_METRICS: Array<{ id: ChartMetric; label: string }> = [
  { id: "price", label: "Price" },
  { id: "mcap", label: "MCap" },
];

const pill = (active: boolean) =>
  cn(
    "num cursor-pointer rounded-full border px-2.5 py-0.5 text-xs",
    active ? "border-white bg-white text-ink" : "border-white/30 text-white/70 hover:border-white",
  );

/**
 * Candlestick dari trade on-chain terindeks. Harga disimpan dalam quote pair lalu ditampilkan dalam
 * USD memakai harga quote SAAT INI, jadi riwayat USD adalah estimasi dan selalu berlabel demikian.
 * Tanpa harga terverifikasi chart kembali ke quote. Mode market cap = harga × supply SAAT INI (burn
 * lama tidak dihitung ulang per candle). Library dimuat saat dibutuhkan saja.
 */
export function CandleChart({
  mint,
  unit,
  supply,
}: {
  mint: string;
  unit: string;
  /** Supply on-chain saat ini, dalam token. */
  supply: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [metric, setMetric] = useState<ChartMetric>("price");
  const [series, setSeries] = useState<{ chart: IChartApi; candles: CandleApi } | null>(null);
  const [interval, setInterval_] = useState<CandleInterval>("5m");
  const [data, setData] = useState<CandleSeries | null>(null);
  const [failedFor, setFailedFor] = useState<CandleInterval | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  // Data interval sebelumnya tidak dipakai: interval baru menunggu datanya sendiri.
  const candles = data?.interval === interval ? data.candles : null;
  const failed = failedFor === interval;
  const quoteUsd = data?.quoteUsd ? Number(data.quoteUsd) : null;
  const inUsd = quoteUsd !== null;
  const scale = (quoteUsd ?? 1) * (metric === "mcap" ? supply : 1);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    let disposed = false;
    let chart: IChartApi | null = null;
    void import("lightweight-charts").then(({ CandlestickSeries, ColorType, createChart }) => {
      if (disposed) return;
      chart = createChart(el, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: CHART.background },
          textColor: CHART.text,
          fontFamily: getComputedStyle(el).getPropertyValue("--font-mono").trim(),
          fontSize: 11,
        },
        grid: {
          vertLines: { color: CHART.grid },
          horzLines: { color: CHART.grid },
        },
        rightPriceScale: { borderColor: CHART.border },
        timeScale: {
          borderColor: CHART.border,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 4,
          barSpacing: 10,
        },
        // Geser vertikal di HP tetap menggulir halaman.
        handleScroll: { vertTouchDrag: false },
      });
      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: CHART.up,
        downColor: CHART.down,
        wickUpColor: CHART.up,
        wickDownColor: CHART.down,
        borderVisible: false,
      });
      chart.subscribeCrosshairMove((param) => {
        setHovered(typeof param.time === "number" ? param.time : null);
      });
      setSeries({ chart, candles: candleSeries });
    });
    return () => {
      disposed = true;
      chart?.remove();
      setSeries(null);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      getCandles(mint, interval)
        .then((res) => {
          if (cancelled) return;
          setData(res.data);
          setFailedFor(null);
        })
        .catch(() => {
          if (!cancelled) setFailedFor(interval);
        });
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    // Tab latar belakang tidak memuat data; begitu dibuka, data dimuat tanpa menunggu timer.
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [mint, interval]);

  useEffect(() => {
    if (!series) return;
    const formatter = inUsd ? formatPrice : formatChartPrice;
    series.chart.applyOptions({ localization: { priceFormatter: formatter } });
    series.candles.applyOptions({
      priceFormat: { type: "custom", formatter, minMove: metric === "mcap" ? 1e-6 : 1e-15 },
    });
  }, [series, inUsd, metric]);

  useEffect(() => {
    if (!series || !candles) return;
    series.candles.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: Number(c.open) * scale,
        high: Number(c.high) * scale,
        low: Number(c.low) * scale,
        close: Number(c.close) * scale,
      })),
    );
  }, [series, candles, scale]);

  // Interval baru: tampilkan candle terbaru, bukan posisi geser interval sebelumnya.
  const loaded = candles !== null;
  useEffect(() => {
    if (series && loaded) series.chart.timeScale().scrollToRealTime();
  }, [series, loaded, interval]);

  const empty = candles?.length === 0;
  const legend =
    candles?.find((c) => c.time === hovered) ?? (candles ? candles[candles.length - 1] : undefined);
  const metricLabel = metric === "mcap" ? "Market cap" : "Price";
  const price = (v: string) => (inUsd ? formatPrice : formatChartPrice)(Number(v) * scale);
  const volume = (v: string) =>
    quoteUsd === null ? `${formatAmount(v)} ${unit}` : `≈ ${formatUsd(Number(v) * quoteUsd)}`;

  return (
    <figure
      className="flex flex-col gap-2"
      aria-label={`Candlestick ${metricLabel.toLowerCase()} chart in ${inUsd ? "USD" : unit}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-white/70">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <div className="flex gap-1" role="group" aria-label="Chart metric">
            {CHART_METRICS.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={m.id === metric}
                onClick={() => setMetric(m.id)}
                className={pill(m.id === metric)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1" role="group" aria-label="Candle interval">
            {CANDLE_INTERVALS.map((i) => (
              <button
                key={i}
                type="button"
                aria-pressed={i === interval}
                onClick={() => setInterval_(i)}
                className={pill(i === interval)}
              >
                {i}
              </button>
            ))}
          </div>
        </div>
        <span className="flex items-center gap-2">
          <span>
            {inUsd
              ? `${metricLabel} (USD, est. at current ${unit} price), UTC`
              : `${metricLabel} (${unit}), UTC`}
          </span>
          <StatusBadge status={inUsd ? "estimated" : "verified"} />
        </span>
      </div>
      <div className="relative">
        <div ref={container} className={cn("h-64 w-full sm:h-80", empty && "invisible")} />
        {(empty || (failed && !loaded)) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center text-sm text-white/80">
            {empty ? (
              <>
                <span>No trades indexed yet.</span>
                <span className="text-xs text-white/60">
                  The chart fills in from on-chain trades as the indexer reads them.
                </span>
              </>
            ) : (
              <span>The chart is unavailable right now.</span>
            )}
          </div>
        )}
      </div>
      <figcaption className="num flex min-h-4 flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-white/70">
        {legend && (
          <>
            <span>{formatDateTime(new Date(legend.time * 1000).toISOString())}</span>
            <span>O {price(legend.open)}</span>
            <span>H {price(legend.high)}</span>
            <span>L {price(legend.low)}</span>
            <span>C {price(legend.close)}</span>
            {legend.volumeQuote !== null && <span>Vol {volume(legend.volumeQuote)}</span>}
            <span>
              {legend.trades} {legend.trades === 1 ? "trade" : "trades"}
            </span>
          </>
        )}
      </figcaption>
    </figure>
  );
}
