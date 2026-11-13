"use client";

import { FEE_CONFIG } from "@liftoff/shared";
import type {
  LaunchInput,
  LaunchRules,
  Pair,
  PairDetail,
  ValidateLaunchResponse,
  ValidationField,
} from "@liftoff/shared";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { WalletButton, XLinkButton } from "@/components/layout/account-buttons";
import { FeeSplitDiagram } from "@/components/token/fee-split-diagram";
import { PairBadge, StatusBadge, Tag } from "@/components/ui/badges";
import { PairPicker } from "@/components/create/pair-picker";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { ImageUpload } from "@/components/ui/image-upload";
import type { PickedImage } from "@/components/ui/image-upload";
import { Button, Card, cn } from "@/components/ui/primitives";
import { ErrorState, Skeleton } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import {
  ApiRequestError,
  createLaunch,
  getLaunchRules,
  getPairDetail,
  getPairs,
  submitAppeal,
  uploadImage,
  validateLaunch,
} from "@/lib/api";
import { useSession } from "@/lib/auth";
import {
  DEPOSIT_REUSE_WINDOW_MS,
  clearPendingDeposit,
  depositProblemOf,
  keepAfterInvalid,
  loadPendingDeposit,
  requiredBalanceLamports,
  savePendingDeposit,
  type PendingDeposit,
} from "@/lib/deposit";
import {
  explorerUrl,
  formatBps,
  formatNumber,
  formatUsd,
  getCluster,
  shortAddress,
} from "@/lib/format";
import { clusterCopy } from "@/lib/cluster";
import { formatUnits } from "@/lib/units";

/** Langkah tombol konfirmasi: bayar biaya launch (wallet) → konfirmasi → buat job launch. */
type SubmitPhase = "idle" | "paying" | "confirming" | "launching";

const PHASE_LABEL: Record<SubmitPhase, string> = {
  idle: "",
  paying: "Approve the launch-cost payment in your wallet…",
  confirming: "Waiting for the payment to confirm on-chain…",
  launching: "Payment confirmed. Creating the launch job…",
};

const STEPS = ["Coin details", "Pick a pair", "Review & launch"] as const;

interface FormState {
  name: string;
  ticker: string;
  description: string;
  website: string;
  telegram: string;
  x: string;
  image: PickedImage | null;
  /** Hasil POST /api/uploads/image untuk `image`. */
  imageRef: string | null;
  pairId: string;
}

const INITIAL: FormState = {
  name: "",
  ticker: "",
  description: "",
  website: "",
  telegram: "",
  x: "",
  image: null,
  imageRef: null,
  pairId: "sol",
};

function toInput(form: FormState): LaunchInput {
  return {
    name: form.name.trim(),
    ticker: form.ticker.trim().replace(/^\$/, "").toUpperCase(),
    description: form.description.trim(),
    website: form.website.trim(),
    telegram: form.telegram.trim(),
    x: form.x.trim(),
    pairId: form.pairId,
    imageRef: form.imageRef,
  };
}

/** Pair yang akan dipakai: jelas sebelum konfirmasi, termasuk mint penuh & peringatannya. */
function SelectedPairCard({ pair, ticker }: { pair: PairDetail; ticker: string }) {
  return (
    <div className="rounded-xl border-2 border-ink bg-accent/10 p-3 text-sm">
      <p className="text-xs text-text-subtle">Trading pair</p>
      <p className="mt-0.5 font-semibold break-words">
        ${ticker} / {pair.symbol} <span className="font-normal text-text-muted">({pair.name})</span>
        {pair.categoryLabel && <span className="font-normal"> · {pair.categoryLabel}</span>}
      </p>
      <p className="num mt-1 text-[11px] break-all text-text-subtle">Quote mint {pair.mint}</p>
      {pair.configId && (
        <p className="num text-[11px] break-all text-text-subtle">
          Config {shortAddress(pair.configId)}
        </p>
      )}
      <p className="mt-1 text-xs text-text-muted">
        1 {pair.symbol} {pair.quoteUsd ? `≈ ${formatUsd(pair.quoteUsd)}` : "USD price: n/a"}
        {pair.curveGraduation && (
          <>
            {" · "}Graduation {formatNumber(pair.curveGraduation)} {pair.symbol}
          </>
        )}
      </p>
      {!pair.supported && pair.unavailableReason && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {pair.unavailableReason}
        </p>
      )}
      {pair.warnings.length > 0 && (
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-xs text-text">
          {pair.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CreateWizard() {
  const copy = clusterCopy(getCluster());
  const session = useSession();
  // Identitas kreator = wallet (SIWS); akun X opsional.
  const wallet = session.user?.wallet ?? null;
  const xHandle = session.xHandle;
  const [rules, setRules] = useState<LaunchRules | null>(null);
  const [uploading, setUploading] = useState(false);
  const router = useRouter();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(INITIAL);
  const [touched, setTouched] = useState<Partial<Record<ValidationField, boolean>>>({});
  const [validation, setValidation] = useState<ValidateLaunchResponse | null>(null);
  const [validatedKey, setValidatedKey] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [pairs, setPairs] = useState<Pair[] | null>(null);
  const [unavailableAssets, setUnavailableAssets] = useState<
    Array<{ symbol: string; reason: string }>
  >([]);
  const [pairsError, setPairsError] = useState(false);
  // Pair terpilih dengan config, raise, harga, dan pemeriksaan mint (pricing hanya untuk pair ini).
  const [pairDetail, setPairDetail] = useState<PairDetail | null>(null);
  const [pairDetailError, setPairDetailError] = useState<{ id: string; message: string } | null>(
    null,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  const [phase, setPhase] = useState<SubmitPhase>("idle");
  const [payError, setPayError] = useState<string | null>(null);
  // Biaya launch yang sudah dibayar tetapi belum dipakai launch (resume tanpa bayar dua kali).
  const [pending, setPending] = useState<PendingDeposit | null>(null);
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();

  // daftar pair dari GET /api/pairs — dimuat dinamis lewat StonkFunAdapter (Spec §6)
  useEffect(() => {
    let cancelled = false;
    getPairs()
      .then((res) => {
        if (cancelled) return;
        setPairs(res.data.pairs);
        setUnavailableAssets(res.data.unavailable);
        // ID pair bergantung sumber (StonkFun: `sf-…`); bila default tidak ada, pilih yang tersedia.
        const first = res.data.pairs.find((p) => p.supported);
        setForm((f) =>
          first && !res.data.pairs.some((p) => p.id === f.pairId) ? { ...f, pairId: first.id } : f,
        );
      })
      .catch(() => {
        if (!cancelled) setPairsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pairs?.some((p) => p.id === form.pairId)) return;
    let cancelled = false;
    getPairDetail(form.pairId)
      .then((res) => {
        if (!cancelled) setPairDetail(res.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPairDetailError({
            id: form.pairId,
            message:
              err instanceof ApiRequestError ? err.message : "Couldn’t check this pair. Try again.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pairs, form.pairId]);

  // upload gambar ke API (pHash dihitung server) setiap kali gambar diganti;
  // hanya hasil upload terakhir yang dipakai
  const uploadSeq = useRef(0);
  function pickImage(img: PickedImage | null) {
    const seq = ++uploadSeq.current;
    setForm((f) => ({ ...f, image: img, imageRef: null }));
    setTouched((t) => ({ ...t, image: true }));
    if (!img) {
      setUploading(false);
      return;
    }
    setUploading(true);
    uploadImage(img.file)
      .then((res) => {
        if (seq === uploadSeq.current) setForm((f) => ({ ...f, imageRef: res.imageRef }));
      })
      .catch((err: unknown) => {
        if (seq !== uploadSeq.current) return;
        toast({
          title: "Image upload failed",
          description: err instanceof ApiRequestError ? err.message : "Try again.",
          tone: "error",
        });
        setForm((f) => ({ ...f, image: null }));
      })
      .finally(() => {
        if (seq === uploadSeq.current) setUploading(false);
      });
  }

  // cek live (POST /api/launch/validate), debounce 350 ms
  const input = useMemo(() => toInput(form), [form]);
  const inputKey = `${JSON.stringify(input)}|${wallet ?? ""}|${xHandle ?? ""}`;
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setChecking(true);
      validateLaunch(input)
        .then((res) => {
          if (cancelled) return;
          setValidation(res);
          setValidatedKey(inputKey);
        })
        .catch(() => {
          if (!cancelled) setValidation(null);
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [input, wallet, xHandle, inputKey]);

  // batas & syarat launch dari config API (Aturan #10: angka tidak ditulis manual)
  useEffect(() => {
    let cancelled = false;
    getLaunchRules()
      .then((r) => {
        if (cancelled) return;
        setRules(r);
        // Pembayaran biaya launch yang belum terpakai (mis. request launch sebelumnya gagal).
        setPending(wallet && r.deposit.enabled ? loadPendingDeposit(wallet, r.deposit) : null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [wallet, xHandle]);

  if (session.loading) {
    return <Skeleton className="h-72 rounded-xl" />;
  }

  if (!wallet) {
    return (
      <Card className="flex flex-col items-center gap-4 border-2 border-ink px-5 py-10 text-center">
        <Image
          src="/brand/fair-launch.webp"
          alt=""
          width={1200}
          height={872}
          sizes="240px"
          className="h-auto w-56"
        />
        <p className="display text-2xl">Sign in with your wallet.</p>
        <p className="max-w-md text-sm text-text-muted">
          Your wallet is your creator identity. Connect it and sign a short message — no
          transaction, no fee.{" "}
          {rules?.deposit.enabled
            ? `When you launch, you pay the ${rules.deposit.sol} SOL launch cost from this wallet; it is refunded only if the launch fails.`
            : "The launch itself is created and paid for by the LIFTOFF master wallet, so it’s free."}{" "}
          Linking an X account is optional.
        </p>
        <WalletButton />
      </Card>
    );
  }

  const reasonFor = (field: ValidationField) =>
    validation?.reasons.find((r) => r.field === field)?.message;
  const show = (field: ValidationField) => touched[field] || step > 0;
  const step1Fields: ValidationField[] = [
    "wallet",
    "name",
    "ticker",
    "image",
    "x_account",
    "x",
    "website",
    "telegram",
  ];
  const fresh = validatedKey === inputKey;
  const step1Ok =
    fresh &&
    !checking &&
    validation !== null &&
    !validation.reasons.some((r) => step1Fields.includes(r.field)) &&
    form.imageRef !== null &&
    !uploading;
  // Hasil pair sebelumnya tidak pernah dipakai: pair baru menunggu pemeriksaannya sendiri.
  const selectedPair = pairDetail?.id === form.pairId ? pairDetail : null;
  const pairCheckError = pairDetailError?.id === form.pairId ? pairDetailError.message : null;

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function touch(field: ValidationField) {
    setTouched((t) => ({ ...t, [field]: true }));
  }

  const depositOn = rules?.deposit.enabled === true;
  const inputJson = JSON.stringify(input);

  /**
   * Bayar biaya launch: transfer SOL wallet creator → master wallet (penerima & jumlah dari
   * GET /api/launch/rules). Signature disimpan begitu wallet mengirimnya, sebelum konfirmasi,
   * supaya tidak pernah ada pembayaran kedua untuk launch yang sama.
   */
  async function payDeposit(r: LaunchRules): Promise<PendingDeposit | null> {
    if (!publicKey) {
      setVisible(true);
      setPayError("Connect your wallet to pay the launch cost.");
      return null;
    }
    if (publicKey.toBase58() !== wallet) {
      setPayError(
        `Switch your wallet to ${shortAddress(wallet!)} (the wallet you signed in with) to pay the launch cost.`,
      );
      return null;
    }
    const balance = BigInt(await connection.getBalance(publicKey, "confirmed"));
    const needed = requiredBalanceLamports(r);
    if (balance < needed) {
      setPayError(
        `Not enough SOL. You need ${formatUnits(needed, 9)} SOL: the ${r.deposit.sol} SOL launch cost, a small network fee, and ${r.minBalanceSol} SOL that must stay in your wallet. Your balance: ${formatUnits(balance, 9)} SOL.`,
      );
      return null;
    }
    setPhase("paying");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: new PublicKey(r.deposit.recipient),
        lamports: BigInt(r.deposit.lamports),
      }),
    );
    const signature = await sendTransaction(tx, connection, { preflightCommitment: "confirmed" });
    const paid: PendingDeposit = {
      wallet: wallet!,
      signature,
      lamports: r.deposit.lamports,
      recipient: r.deposit.recipient,
      sentAt: Date.now(),
      idempotencyKey: null,
      inputKey: null,
    };
    savePendingDeposit(paid);
    setPending(paid);
    setPhase("confirming");
    try {
      const res = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      if (res.value.err)
        throw new Error(`Payment failed on-chain: ${JSON.stringify(res.value.err)}`);
    } catch (err) {
      // Kedaluwarsa/gagal = tidak ada SOL yang berpindah → lupakan signature ini.
      const status = (await connection.getSignatureStatus(signature)).value;
      if (!status || status.err) {
        clearPendingDeposit();
        setPending(null);
        throw err;
      }
    }
    return paid;
  }

  async function submit() {
    setSubmitting(true);
    setPayError(null);
    let deposit: PendingDeposit | null = null;
    try {
      if (depositOn && rules) {
        deposit = pending ?? (await payDeposit(rules));
        if (!deposit) {
          setSubmitting(false);
          return;
        }
        // Key yang sama untuk input + deposit yang sama (replay aman setelah reload).
        if (deposit.inputKey === inputJson && deposit.idempotencyKey) {
          idempotencyKey.current = deposit.idempotencyKey;
        }
      }
      // idempotency key tetap sama jika pengguna menekan konfirmasi lagi
      idempotencyKey.current ??= crypto.randomUUID();
      if (deposit) {
        deposit = { ...deposit, idempotencyKey: idempotencyKey.current, inputKey: inputJson };
        savePendingDeposit(deposit);
      }
      setPhase("launching");
      const job = await createLaunch(input, idempotencyKey.current, deposit?.signature);
      // Pembayaran kini terikat ke job ini (disimpan jika live, dikembalikan jika gagal).
      if (deposit) clearPendingDeposit();
      toast({
        title: "Launch job created",
        description: `Initial status: ${job.status}`,
        tone: "success",
      });
      router.push(`/launch/${job.id}`);
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.body?.error.code : undefined;
      const reasons = err instanceof ApiRequestError ? err.body?.error.reasons : undefined;
      let keptPayment = deposit !== null;
      if (deposit && code === "launch_deposit_reused") keptPayment = false;
      if (deposit && code === "launch_deposit_invalid") {
        const status = await connection
          .getSignatureStatus(deposit.signature, { searchTransactionHistory: true })
          .then((s) => s.value)
          .catch(() => null);
        const confirmed = !!status && !status.err && status.confirmationStatus !== "processed";
        keptPayment = keepAfterInvalid((err as ApiRequestError).message, confirmed);
      }
      if (deposit && !keptPayment) {
        clearPendingDeposit();
        setPending(null);
      }
      const message =
        err instanceof ApiRequestError
          ? reasons?.length
            ? reasons.map((r) => r.message).join(" ")
            : err.message
          : depositProblemOf(err).message;
      const resume =
        keptPayment && deposit
          ? ` Your ${rules?.deposit.sol} SOL launch-cost payment is saved: launching again reuses it, so you won’t pay twice.`
          : "";
      setPayError(`${message}${resume}`);
      toast({
        title: deposit || !depositOn ? "Couldn’t create the launch job" : "Launch cost not paid",
        description: `${message}${resume}`,
        tone: "error",
      });
      // Penolakan bisnis bersifat final untuk input ini; key baru untuk percobaan berikutnya.
      if (err instanceof ApiRequestError && err.status !== 429 && err.status < 500) {
        idempotencyKey.current = null;
      }
      setSubmitting(false);
      setConfirmOpen(false);
    } finally {
      setPhase("idle");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <ol className="grid grid-cols-3 gap-2" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li
            key={label}
            aria-current={i === step ? "step" : undefined}
            className={cn(
              "flex flex-col gap-1.5 border-t-[3px] pt-2 text-xs",
              i < step
                ? "border-ink text-text-muted"
                : i === step
                  ? "border-accent font-semibold text-text"
                  : "border-line text-text-subtle",
            )}
          >
            <span className="num">0{i + 1}</span>
            <span className="truncate">{label}</span>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card className="flex flex-col gap-5 border-2 border-ink p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-text-muted">
              Creator: <span className="num text-text">{shortAddress(wallet)}</span>{" "}
              {xHandle ? (
                <Tag tone="success">
                  Verified creator · {xHandle}
                  {session.user?.xDevLink ? " (DEV)" : ""}
                </Tag>
              ) : (
                <span className="text-text-subtle">
                  — link X (optional) for a verified-creator badge
                  {rules && rules.perWalletWithXPer24h > rules.perWalletPer24h
                    ? ` and up to ${rules.perWalletWithXPer24h} launches per 24 h`
                    : ""}
                  .
                </span>
              )}
            </span>
            {!xHandle && <XLinkButton compact />}
            {(reasonFor("wallet") || reasonFor("x_account")) && (
              <p className="w-full text-xs text-danger">
                {reasonFor("wallet") ?? reasonFor("x_account")}
              </p>
            )}
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <FormField
              id="name"
              label="Name"
              required
              hint="Compared with existing tokens for similarity."
              error={show("name") ? reasonFor("name") : undefined}
            >
              {(p) => (
                <input
                  {...p}
                  value={form.name}
                  maxLength={32}
                  placeholder="Orbit Cat"
                  onChange={(e) => set("name", e.target.value)}
                  onBlur={() => touch("name")}
                />
              )}
            </FormField>
            <FormField
              id="ticker"
              label="Ticker"
              required
              prefix="$"
              hint="Compared after normalization (case, homoglyphs, leetspeak). A repeat raises the risk level."
              error={show("ticker") && form.ticker ? reasonFor("ticker") : undefined}
              state={
                !form.ticker ? "idle" : checking ? "checking" : reasonFor("ticker") ? "error" : "ok"
              }
            >
              {(p) => (
                <input
                  {...p}
                  value={form.ticker}
                  maxLength={10}
                  placeholder="ORBIT"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    set("ticker", e.target.value.replace(/^\$/, "").toUpperCase());
                    touch("ticker");
                  }}
                />
              )}
            </FormField>
          </div>
          {form.ticker && validation && (
            <p className="-mt-3 text-xs text-text-subtle">
              Normalized:{" "}
              <span className="num text-text-muted">{validation.tickerNormalized || "—"}</span> ·
              try <span className="num">B0NK</span> (trades elsewhere) to see a risk signal.
            </p>
          )}
          <ImageUpload
            value={form.image}
            onChange={pickImage}
            error={
              touched.image
                ? form.image
                  ? uploading
                    ? undefined
                    : reasonFor("image")
                  : "An image is required."
                : undefined
            }
          />
          <FormField id="description" label="Description" hint={`${form.description.length}/280`}>
            {(p) => (
              <textarea
                {...p}
                rows={3}
                maxLength={280}
                value={form.description}
                placeholder="Tell people about your coin, briefly."
                onChange={(e) => set("description", e.target.value)}
              />
            )}
          </FormField>
          <div className="grid gap-5 sm:grid-cols-3">
            <FormField id="x" label="X account" error={show("x") ? reasonFor("x") : undefined}>
              {(p) => (
                <input
                  {...p}
                  value={form.x}
                  placeholder="@project or https://x.com/…"
                  autoComplete="off"
                  onChange={(e) => set("x", e.target.value)}
                  onBlur={() => touch("x")}
                />
              )}
            </FormField>
            <FormField
              id="website"
              label="Website"
              error={show("website") ? reasonFor("website") : undefined}
            >
              {(p) => (
                <input
                  {...p}
                  type="url"
                  inputMode="url"
                  value={form.website}
                  placeholder="https://"
                  onChange={(e) => set("website", e.target.value)}
                  onBlur={() => touch("website")}
                />
              )}
            </FormField>
            <FormField
              id="telegram"
              label="Telegram"
              error={show("telegram") ? reasonFor("telegram") : undefined}
            >
              {(p) => (
                <input
                  {...p}
                  type="url"
                  inputMode="url"
                  value={form.telegram}
                  placeholder="https://t.me/…"
                  onChange={(e) => set("telegram", e.target.value)}
                  onBlur={() => touch("telegram")}
                />
              )}
            </FormField>
          </div>
          {fresh && validation?.risk && (
            <RiskPanel
              risk={validation.risk}
              input={input}
              canAppeal={
                validation.risk.level === "high" &&
                !validation.risk.appealApproved &&
                form.imageRef !== null
              }
            />
          )}
          <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
            <span className="text-xs text-text-subtle">
              {uploading
                ? "Uploading image…"
                : checking || !fresh
                  ? "Checking…"
                  : step1Ok
                    ? "All checks passed"
                    : "Fill in the required fields"}
            </span>
            <Button
              variant="primary"
              disabled={!step1Ok}
              onClick={() => {
                setTouched({
                  name: true,
                  ticker: true,
                  image: true,
                  website: true,
                  telegram: true,
                  x: true,
                });
                if (step1Ok) setStep(1);
              }}
            >
              Continue
            </Button>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card className="flex flex-col gap-5 border-2 border-ink p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-text-muted">{copy.createPairsIntro}</p>
            <StatusBadge status="estimated" />
          </div>
          {pairsError ? (
            <ErrorState title="Couldn’t load pairs" description="Reload the page." />
          ) : !pairs ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-28 rounded-xl" />
              ))}
            </div>
          ) : (
            <PairPicker
              pairs={pairs}
              selectedId={form.pairId}
              onSelect={(id) => set("pairId", id)}
            />
          )}
          {pairCheckError && (
            <p role="alert" className="text-sm text-danger">
              {pairCheckError}
            </p>
          )}
          {!selectedPair && !pairCheckError && pairs && <Skeleton className="h-20 rounded-xl" />}
          {selectedPair && <SelectedPairCard pair={selectedPair} ticker={input.ticker} />}
          {unavailableAssets.length > 0 && (
            <p className="text-xs text-text-subtle">
              Not available on {getCluster()}: {unavailableAssets.map((a) => a.symbol).join(", ")} —
              no StonkFun / LaunchLab config exists for them here.
            </p>
          )}
          <p className="text-xs text-text-subtle">{copy.createPairsFootnote}</p>
          <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button
              variant="primary"
              disabled={!selectedPair?.supported}
              onClick={() => setStep(2)}
            >
              Continue
            </Button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-4">
          <Card className="border-2 border-ink p-4 sm:p-6">
            <div className="flex items-start gap-4">
              {form.image && (
                // eslint-disable-next-line @next/next/no-img-element -- preview data URL lokal
                <img
                  src={form.image.dataUrl}
                  alt=""
                  className="size-16 shrink-0 rounded-full border-2 border-ink object-cover"
                />
              )}
              <div className="min-w-0">
                <p className="display flex flex-wrap items-center gap-2 text-2xl">
                  ${input.ticker} <PairBadge symbol={selectedPair?.symbol ?? "?"} />
                </p>
                <p className="text-sm text-text-muted">{input.name}</p>
                <p className="mt-1 text-xs text-text-subtle">
                  Creator <span className="num">{shortAddress(wallet)}</span>
                  {xHandle ? ` · verified ${xHandle}` : " · no X linked"}
                </p>
              </div>
              <Tag tone="accent" className="ml-auto shrink-0">
                {rules === null
                  ? "Launch cost …"
                  : depositOn
                    ? `Launch cost ${rules.deposit.sol} SOL`
                    : "Free launch"}
              </Tag>
            </div>
            {input.description && (
              <p className="mt-4 text-sm text-text-muted">{input.description}</p>
            )}
            {selectedPair && (
              <div className="mt-4">
                <SelectedPairCard pair={selectedPair} ticker={input.ticker} />
              </div>
            )}
            <dl className="mt-4 grid gap-3 border-t border-line pt-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-text-subtle">Launch cost to you</dt>
                <dd className="mt-0.5">
                  {rules === null ? (
                    "—"
                  ) : depositOn ? (
                    <>
                      <span className="num font-semibold">{rules.deposit.sol} SOL</span> + network
                      fee, paid from your wallet
                    </>
                  ) : (
                    "Free — paid by LIFTOFF’s launch authority"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-text-subtle">Dev wallet / creator allocation</dt>
                <dd className="mt-0.5">None</dd>
              </div>
              <div>
                <dt className="text-xs text-text-subtle">Creator fee (to LIFTOFF, not to you)</dt>
                <dd className="mt-0.5">
                  <span className="num">{formatBps(FEE_CONFIG.creatorFeeBps)}</span> per curve trade
                  → <span className="num">{formatBps(FEE_CONFIG.split.buybackBurn)}</span> buyback
                  &amp; burn /{" "}
                  <span className="num">{formatBps(FEE_CONFIG.split.convictionReserve)}</span>{" "}
                  Conviction Reserve
                </dd>
              </div>
              <div>
                <dt className="text-xs text-text-subtle">Anti-copycat risk</dt>
                <dd className="mt-0.5 capitalize">
                  {validation?.risk?.level ?? "—"}
                  {validation?.risk?.appealApproved ? " (appeal approved)" : ""}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-text-subtle">Graduation</dt>
                <dd className="num mt-0.5">
                  {selectedPair?.curveGraduation
                    ? `${formatNumber(selectedPair.curveGraduation)} ${selectedPair.symbol}`
                    : "—"}{" "}
                  <span className="text-text-subtle">
                    {selectedPair?.curveGraduationUsd
                      ? `≈ ${formatUsd(selectedPair.curveGraduationUsd)}`
                      : "USD n/a"}
                  </span>{" "}
                  <StatusBadge status="estimated" />
                </dd>
              </div>
            </dl>
          </Card>

          {rules && depositOn && (
            <Card className="border-2 border-ink p-4 sm:p-6" aria-labelledby="launch-cost-title">
              <h2 id="launch-cost-title" className="mb-3 text-sm font-semibold">
                Launch cost: <span className="num">{rules.deposit.sol} SOL</span>, paid by you
              </h2>
              <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-text-muted">
                <li>
                  Creating a coin on-chain costs SOL (accounts for the mint, pool and vaults). You
                  pay it: when you confirm, your wallet asks you to approve a transfer of{" "}
                  <span className="num text-text">{rules.deposit.sol} SOL</span> to LIFTOFF’s launch
                  wallet{" "}
                  <a
                    href={explorerUrl("address", rules.deposit.recipient)}
                    target="_blank"
                    rel="noreferrer"
                    className="num underline"
                  >
                    {shortAddress(rules.deposit.recipient)}
                  </a>
                  , plus a small network fee.
                </li>
                <li>
                  If your coin goes live, the payment is kept: it covers the creation cost. If the
                  launch fails permanently, it is refunded to your wallet automatically.
                </li>
                <li>
                  If the payment goes through but the launch request fails, it is saved for{" "}
                  {DEPOSIT_REUSE_WINDOW_MS / 3_600_000} hours: launching again reuses it, so you
                  never pay twice.
                </li>
                {Number(rules.minBalanceSol) > 0 && (
                  <li>
                    Your wallet must still hold at least{" "}
                    <span className="num">{rules.minBalanceSol} SOL</span> after paying (checked,
                    not charged), so you need about{" "}
                    <span className="num text-text">
                      {formatUnits(requiredBalanceLamports(rules), 9)} SOL
                    </span>{" "}
                    in total.
                  </li>
                )}
              </ul>
              {pending && (
                <p className="mt-3 rounded-xl border-2 border-ink bg-accent/10 p-3 text-sm">
                  Launch cost already paid (
                  <a
                    href={explorerUrl("tx", pending.signature)}
                    target="_blank"
                    rel="noreferrer"
                    className="num underline"
                  >
                    {shortAddress(pending.signature, 6)}
                  </a>
                  ). Your next launch reuses this payment — you won’t be charged again.
                </p>
              )}
            </Card>
          )}

          <Card className="p-4 sm:p-6">
            <h2 className="mb-3 text-sm font-semibold">Rules</h2>
            <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-text-muted">
              <li>
                The token is created by LIFTOFF’s launch authority (master wallet) with the StonkFun
                platform config on Raydium LaunchLab.{" "}
                {depositOn ? "You pay only the launch cost above" : "You pay nothing"} and receive
                no token allocation; there is no buy inside the creation transaction.
              </li>
              <li>{copy.createDependency}</li>
              <li>{copy.createSniper}</li>
              <li>The mint address is only published after the launch is verified on-chain.</li>
              <li>
                Your wallet is your identity. Linking X is optional; a linked X account can only
                have one active coin.
              </li>
              {rules && (
                <li>
                  Launch limit: {rules.perWalletPer24h} per wallet per 24 hours (
                  {rules.perWalletWithXPer24h} with a linked X account). Your wallet needs at least{" "}
                  {rules.minBalanceSol} SOL — only checked, never charged
                  {depositOn ? " (checked after the launch cost is paid)" : ""}.
                  {rules.minWalletAgeDays > 0
                    ? ` Wallets must be at least ${rules.minWalletAgeDays} days old.`
                    : ""}
                </li>
              )}
              <li>
                Until this token graduates, its Conviction Reserve is held untouched in its own
                custody account.
              </li>
            </ul>
          </Card>

          <Card className="p-4 sm:p-6">
            <h2 className="mb-4 text-sm font-semibold">Creator-fee split</h2>
            <FeeSplitDiagram />
          </Card>

          <label className="flex items-start gap-3 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className="mt-0.5 size-4 accent-[var(--color-accent)]"
            />
            <span>
              I understand the rules above, that this is not financial advice, and that the token’s
              price can go to zero.
            </span>
          </label>

          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button
              variant="primary"
              disabled={!accepted || rules === null}
              onClick={() => {
                setPayError(null);
                setConfirmOpen(true);
              }}
            >
              Launch ${input.ticker}
            </Button>
          </div>
          {payError && !confirmOpen && (
            <p role="alert" className="text-sm text-danger">
              {payError}
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={`Launch $${input.ticker}?`}
        confirmLabel={
          depositOn && !pending ? `Pay ${rules?.deposit.sol} SOL & launch` : "Yes, launch"
        }
        busy={submitting}
        onConfirm={submit}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>
          LIFTOFF’s master wallet creates <span className="num text-text">${input.ticker}</span>{" "}
          trading against{" "}
          <span className="text-text">
            {selectedPair?.symbol ?? "?"} ({selectedPair?.name ?? "?"})
          </span>{" "}
          on-chain.{" "}
          {!depositOn
            ? "You don’t sign or pay anything; you can follow the launch on the next page."
            : pending
              ? "Your launch cost is already paid; this reuses that payment. You can follow the launch on the next page."
              : `Your wallet will ask you to approve a ${rules?.deposit.sol} SOL launch-cost payment (plus network fee). It is kept if the coin goes live and refunded only if the launch fails permanently.`}
        </p>
        {selectedPair && (
          <>
            <p className="num mt-2 text-[11px] break-all">Quote mint {selectedPair.mint}</p>
            {selectedPair.warnings.map((w) => (
              <p key={w} className="mt-2 text-text">
                {w}
              </p>
            ))}
          </>
        )}
        {phase !== "idle" && (
          <p className="mt-3 font-semibold text-text" aria-live="polite">
            {PHASE_LABEL[phase]}
          </p>
        )}
        {payError && (
          <p role="alert" className="mt-3 text-danger">
            {payError}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** Spec §7: tingkat risiko + alasan; High diblok dan bisa dibanding. */
function RiskPanel({
  risk,
  input,
  canAppeal,
}: {
  risk: NonNullable<ValidateLaunchResponse["risk"]>;
  input: LaunchInput;
  canAppeal: boolean;
}) {
  const { toast } = useToast();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const tone = risk.level === "low" ? "success" : risk.level === "medium" ? "warn" : "danger";

  async function appeal() {
    setSending(true);
    try {
      await submitAppeal({ ...input, message });
      setSent(true);
      toast({
        title: "Appeal submitted",
        description: "The LIFTOFF owner will review it.",
        tone: "success",
      });
    } catch (err) {
      toast({
        title: "Couldn’t submit the appeal",
        description: err instanceof ApiRequestError ? err.message : "Try again.",
        tone: "error",
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-bg p-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Anti-copycat check</span>
        <Tag tone={tone}>
          {risk.level} risk{risk.appealApproved ? " · appeal approved" : ""}
        </Tag>
      </p>
      {risk.indicators.length === 0 ? (
        <p className="text-xs text-text-muted">No significant duplication detected.</p>
      ) : (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-text-muted">
          {risk.indicators.map((i) => (
            <li key={`${i.code}-${i.relatedTicker ?? ""}`}>{i.message}</li>
          ))}
        </ul>
      )}
      {risk.level === "medium" && (
        <p className="text-xs text-text-subtle">
          Medium risk is allowed; these reasons are recorded with the token.
        </p>
      )}
      {canAppeal && !sent && (
        <div className="flex flex-col gap-2 border-t border-line pt-2">
          <label htmlFor="appeal-message" className="text-xs text-text-muted">
            Legitimate project? Explain why (for example, link to an official announcement). The
            LIFTOFF owner reviews appeals; an approved appeal unlocks exactly this launch once.
          </label>
          <textarea
            id="appeal-message"
            rows={3}
            maxLength={1000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="rounded-lg border border-line bg-surface p-2 text-sm"
          />
          <Button disabled={message.trim().length < 20 || sending} onClick={appeal}>
            Submit appeal
          </Button>
        </div>
      )}
      {sent && (
        <p className="text-xs text-text-muted">
          Appeal submitted. Come back to this form after it is approved.
        </p>
      )}
    </div>
  );
}
