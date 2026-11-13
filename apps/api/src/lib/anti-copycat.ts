/**
 * Cek launch: anti-copycat Spec §7 (indikator + risiko Low / Medium / High) dan aturan launch
 * lain (wallet, kuota, pair StonkFun). Menghasilkan `ok` / `rejected` dengan alasan yang bisa
 * dibaca pengguna.
 *
 *  - Indikator duplikasi TIDAK langsung menolak: dijumlahkan menjadi skor risiko. Low & Medium
 *    boleh launch (Medium ditampilkan dengan alasannya); High diblok otomatis kecuali banding
 *    untuk input yang sama sudah disetujui pemilik (routes/appeals.ts).
 *  - Ticker berulang hanya satu indikator (Spec: "must not automatically assume that every
 *    repeated ticker is fraudulent").
 *  - Pair & config berasal dari StonkFunAdapter (Spec §4, §6); tidak tersedia → ditolak aman.
 */
import { createHash } from "node:crypto";
import type { Db } from "@liftoff/db";
import {
  adoptionRequirementViolations,
  classifyRisk,
  displayTicker,
  hammingDistance,
  isAsciiTicker,
  launchFingerprint,
  nameSimilarity,
  normalizeName,
  normalizeTelegram,
  normalizeTicker,
  normalizeWebsite,
  normalizeXAccount,
  requireLaunchablePair,
  StonkFunUnavailableError,
  TICKER_MAX_LENGTH,
  TICKER_MIN_NORMALIZED_LENGTH,
  type AntiCopycatConfig,
  type LaunchLimitsConfig,
  type RiskIndicator,
  type RiskReport,
  type SolanaCluster,
  type StonkFunAdapter,
  type StonkFunPair,
  type ValidateLaunchResponse,
  type ValidationReason,
  type WalletRequirementsConfig,
} from "@liftoff/shared";
import type { ExternalTickerSource } from "./external-tickers";
import type { ImageStore } from "./images";
import { countWalletLaunches, walletLimit, walletLimitMessage } from "./launch-quota";
import type { SessionUser } from "./session";
import type { WalletChecker } from "./wallet-check";

export interface CheckInput {
  name?: string | undefined;
  ticker?: string | undefined;
  pairId?: string | undefined;
  imageRef?: string | null | undefined;
  website?: string | undefined;
  telegram?: string | undefined;
  x?: string | undefined;
  description?: string | undefined;
}

export interface CheckContext {
  db: Db;
  config: AntiCopycatConfig;
  cluster: SolanaCluster;
  external: ExternalTickerSource;
  images: ImageStore;
  stonkfun: StonkFunAdapter;
  walletChecker: WalletChecker;
  walletRequirements: WalletRequirementsConfig;
  launchLimits: LaunchLimitsConfig;
  user: SessionUser | null;
}

export interface NormalizedLinks {
  nameNormalized: string;
  xNormalized: string | null;
  websiteNormalized: string | null;
  telegramNormalized: string | null;
}

export interface CheckResult extends ValidateLaunchResponse {
  pair: StonkFunPair | null;
  /** launchFingerprint() config StonkFun saat ini; null jika pair tidak tersedia. */
  fingerprint: string | null;
  imageHash: string | null;
  normalized: NormalizedLinks;
  /** Banding disetujui yang membuka launch High-risk ini (dipakai sekali). */
  appealId: string | null;
  inputHash: string;
}

const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Hash input kanonik untuk mencocokkan banding dengan launch (input harus identik). */
export function appealInputHash(input: CheckInput): string {
  const canonical = {
    name: normalizeName(input.name ?? ""),
    ticker: normalizeTicker(input.ticker ?? ""),
    pairId: input.pairId ?? "",
    imageRef: input.imageRef ?? null,
    website: normalizeWebsite(input.website),
    telegram: normalizeTelegram(input.telegram),
    x: normalizeXAccount(input.x),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function checkLaunch(input: CheckInput, ctx: CheckContext): Promise<CheckResult> {
  const reasons: ValidationReason[] = [];
  const warnings: string[] = [];
  const indicators: RiskIndicator[] = [];
  const w = ctx.config.riskWeights;
  const rawTicker = input.ticker?.trim() ?? "";
  const tickerNormalized = normalizeTicker(rawTicker);
  const normalized: NormalizedLinks = {
    nameNormalized: normalizeName(input.name ?? ""),
    xNormalized: normalizeXAccount(input.x),
    websiteNormalized: normalizeWebsite(input.website),
    telegramNormalized: normalizeTelegram(input.telegram),
  };
  /** Token pembanding: semua token yang tidak gagal, kecuali milik kreator yang sama. */
  const others = { launchStatus: { not: "failed" as const } };
  const notMine = ctx.user ? { creatorUserId: { not: ctx.user.id } } : {};

  // --- wallet (identitas utama, SIWS): sign-in, kuota 24 jam, syarat minimum
  if (!ctx.user) {
    reasons.push({
      field: "wallet",
      code: "wallet_sign_in_required",
      message: "Connect and sign in with your wallet first.",
    });
  } else {
    const hasX = ctx.user.xUserId !== null;
    const limit = walletLimit(ctx.launchLimits, hasX);
    if ((await countWalletLaunches(ctx.db, ctx.user.id)) >= limit) {
      reasons.push({
        field: "wallet",
        code: "wallet_daily_limit",
        message: walletLimitMessage(limit, hasX, ctx.launchLimits),
      });
    }
    const wallet = await ctx.walletChecker.check(ctx.user.wallet, ctx.walletRequirements);
    if (wallet.status === "failed") {
      reasons.push({ field: "wallet", code: wallet.code, message: wallet.message });
    } else if (wallet.status === "unavailable") {
      reasons.push({
        field: "wallet",
        code: "wallet_check_unavailable",
        message: "We couldn't check your wallet right now. Please try again in a few minutes.",
      });
    }
  }

  // --- akun X tertaut (opsional): satu akun X tertaut = satu koin aktif
  if (ctx.user?.xUserId) {
    const active = await ctx.db.xAccountClaim.findFirst({
      where: { xUserId: ctx.user.xUserId, status: "active" },
      include: { token: { select: { ticker: true } } },
    });
    if (active) {
      reasons.push({
        field: "x_account",
        code: "x_account_has_active_token",
        message: `@${ctx.user.xHandle} already has an active coin (${active.token.ticker}). One linked X account = one active coin.`,
      });
    }
  }

  // --- pair (StonkFun supported pairs, dimuat dinamis)
  let pair: StonkFunPair | null = null;
  let fingerprint: string | null = null;
  if (input.pairId !== undefined) {
    try {
      const [list, launchConfig] = await Promise.all([
        ctx.stonkfun.listPairs(),
        ctx.stonkfun.activeLaunchConfig(),
      ]);
      pair = await ctx.stonkfun.resolvePair(requireLaunchablePair(list, { id: input.pairId }));
      if (!pair.launchLabReady) {
        throw new StonkFunUnavailableError(
          "pair_unavailable",
          pair.unavailableReason ?? `${pair.symbol} is not launchable right now.`,
        );
      }
      const pricing = await ctx.stonkfun.launchPricing(pair);
      // Ditolak di sini, sebelum pengguna membayar deposit, bukan baru di worker.
      const violations = adoptionRequirementViolations(pricing, pair, {
        requireCurveRule: ctx.stonkfun.source === "stonkfun_mainnet",
      });
      if (violations.length) {
        throw new StonkFunUnavailableError(
          "pair_unavailable",
          `StonkFun would not adopt a launch on this pair (${violations.join("; ")}).`,
        );
      }
      fingerprint = launchFingerprint(launchConfig, pair, pricing);
    } catch (err) {
      if (!(err instanceof StonkFunUnavailableError)) throw err;
      pair = null;
      reasons.push({
        field: "pair",
        code: err.code === "pair_unavailable" ? "pair_unsupported" : "stonkfun_unavailable",
        message: err.message,
      });
    }
  }

  // --- ticker: format (hard), lalu indikator risiko
  if (rawTicker) {
    const display = displayTicker(rawTicker);
    if (!isAsciiTicker(rawTicker)) {
      reasons.push({
        field: "ticker",
        code: "ticker_non_ascii",
        message:
          "Ticker may only use letters A–Z and numbers 0–9 (look-alike characters are not allowed).",
      });
    }
    if (
      tickerNormalized.length < TICKER_MIN_NORMALIZED_LENGTH ||
      display.length > TICKER_MAX_LENGTH
    ) {
      reasons.push({
        field: "ticker",
        code: "ticker_format",
        message: `Ticker must be ${TICKER_MIN_NORMALIZED_LENGTH}–${TICKER_MAX_LENGTH} characters.`,
      });
    } else {
      const claim = await ctx.db.tickerClaim.findFirst({
        where: { tickerNormalized, status: "active", token: notMine },
        include: { token: { select: { ticker: true } } },
        orderBy: { createdAt: "asc" },
      });
      if (claim) {
        const existing = claim.token.ticker;
        indicators.push({
          code: "ticker_repeated",
          field: "ticker",
          weight: w.ticker_repeated,
          relatedTicker: existing,
          message:
            existing.toUpperCase() === display
              ? `$${existing} already exists on LIFTOFF. A repeated ticker alone is allowed, but it counts toward the risk score.`
              : `$${display} looks like the existing $${existing} (same after removing case, spacing, look-alike letters and leetspeak).`,
        });
      }
      const ext = await ctx.external.lookup(rawTicker, ctx.config.externalMinLiquidityUsd);
      if (ext.status === "found") {
        const top = ext.matches[0]!;
        indicators.push({
          code: "ticker_external",
          field: "ticker",
          weight: w.ticker_external,
          relatedTicker: top.symbol,
          message: `$${top.symbol} already trades outside LIFTOFF with real liquidity (${fmtUsd(top.liquidityUsd)}, ≥ ${fmtUsd(ctx.config.externalMinLiquidityUsd)}).`,
        });
      } else if (ext.status === "unavailable") {
        if (ctx.config.externalUnavailablePolicy === "reject") {
          reasons.push({
            field: "ticker",
            code: "ticker_external_check_unavailable",
            message:
              "We couldn't check whether this ticker already trades elsewhere. Please try again in a few minutes.",
          });
        } else {
          warnings.push(
            `External ticker check unavailable (${ctx.external.name}: ${ext.error}); allowed by config.`,
          );
        }
      }
    }
  }

  // --- nama (Spec §7 Token Name Similarity)
  if (normalized.nameNormalized.length >= 2) {
    const identical = await ctx.db.token.findFirst({
      where: { ...others, ...notMine, nameNormalized: normalized.nameNormalized },
      select: { ticker: true, name: true },
    });
    if (identical) {
      indicators.push({
        code: "name_identical",
        field: "name",
        weight: w.name_identical,
        relatedTicker: identical.ticker,
        message: `The name matches "${identical.name}" ($${identical.ticker}) after normalization.`,
      });
    } else {
      // Skala kecil: perbandingan linear. Jika token > ~100k, ganti dengan index trigram.
      const names = await ctx.db.token.findMany({
        where: { ...others, ...notMine },
        select: { ticker: true, name: true },
      });
      const similar = names
        .map((t) => ({ ...t, score: nameSimilarity(input.name ?? "", t.name) }))
        .filter((t) => t.score >= ctx.config.nameSimilarityThreshold)
        .sort((a, b) => b.score - a.score)[0];
      if (similar) {
        indicators.push({
          code: "name_similar",
          field: "name",
          weight: w.name_similar,
          relatedTicker: similar.ticker,
          message: `The name is ${Math.round(similar.score * 100)}% similar to "${similar.name}" ($${similar.ticker}).`,
        });
      }
    }
  }

  // --- gambar (pHash)
  let imageHash: string | null = null;
  if (input.imageRef) {
    imageHash = await ctx.images.hash(input.imageRef);
    if (!imageHash) {
      reasons.push({ field: "image", code: "image_not_found", message: "Upload the image again." });
    } else {
      const images = await ctx.db.token.findMany({
        where: { ...others, ...notMine, imageHash: { not: null } },
        select: { ticker: true, imageHash: true },
      });
      // Skala kecil: perbandingan linear. Jika token > ~100k, ganti dengan BK-tree / index LSH.
      const similar = images.find(
        (t) => hammingDistance(t.imageHash!, imageHash!) <= ctx.config.imageHashMaxDistance,
      );
      if (similar) {
        indicators.push({
          code: "image_similar",
          field: "image",
          weight: w.image_similar,
          relatedTicker: similar.ticker,
          message: `The image is nearly identical to the image of $${similar.ticker} (e.g. resized, recolored or cropped copy).`,
        });
      }
    }
  }

  // --- akun X / website / Telegram yang sudah dipakai token lain (Spec §7 Social Duplication)
  const socials = [
    ["x", "xNormalized", "social_x_reused", "X account"],
    ["website", "websiteNormalized", "social_website_reused", "website"],
    ["telegram", "telegramNormalized", "social_telegram_reused", "Telegram link"],
  ] as const;
  for (const [field, column, code, label] of socials) {
    const value = normalized[column];
    if (!value) continue;
    const used = await ctx.db.token.findFirst({
      where: { ...others, ...notMine, [column]: value },
      select: { ticker: true },
    });
    if (used) {
      indicators.push({
        code,
        field,
        weight: w[code],
        relatedTicker: used.ticker,
        message: `This ${label} is already used by $${used.ticker}.`,
      });
    }
  }
  if (normalized.xNormalized) {
    // Akun X yang sudah ditautkan (OAuth) oleh wallet lain = milik orang lain.
    const owner = await ctx.db.user.findFirst({
      where: {
        xHandle: { equals: normalized.xNormalized, mode: "insensitive" },
        ...(ctx.user ? { id: { not: ctx.user.id } } : {}),
      },
      select: { id: true },
    });
    if (owner && !indicators.some((i) => i.code === "social_x_reused")) {
      indicators.push({
        code: "social_x_reused",
        field: "x",
        weight: w.social_x_reused,
        relatedTicker: null,
        message: `@${normalized.xNormalized} is linked to another LIFTOFF wallet.`,
      });
    }
  }

  // --- klasifikasi risiko + banding
  const assessment = classifyRisk(indicators, ctx.config);
  const inputHash = appealInputHash(input);
  let appealId: string | null = null;
  if (assessment.level === "high" && ctx.user) {
    const appeal = await ctx.db.launchAppeal.findFirst({
      where: { userId: ctx.user.id, inputHash, status: "approved" },
      select: { id: true },
    });
    appealId = appeal?.id ?? null;
  }
  const risk: RiskReport = { ...assessment, appealApproved: appealId !== null };
  if (assessment.level === "high" && !appealId) {
    reasons.push({
      field: indicators[0]?.field === "image" ? "image" : (indicators[0]?.field ?? "name"),
      code: "risk_high",
      message:
        "High risk: several signals suggest this launch may impersonate another project. It is blocked automatically; if it is legitimate, submit an appeal for review.",
    });
  }

  return {
    result: reasons.length === 0 ? "ok" : "rejected",
    tickerNormalized: tickerNormalized.toUpperCase(),
    reasons,
    warnings,
    risk,
    pair,
    fingerprint,
    imageHash,
    normalized,
    appealId,
    inputHash,
  };
}
