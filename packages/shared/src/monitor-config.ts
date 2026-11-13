/**
 * Monitoring & alert (Tahap 9). Ambang untuk ringkasan status (`GET /api/health/status`) dan
 * proses `monitor` worker. Ambang economic engine (saldo master, gagal berulang) tetap di
 * ECONOMIC_CONFIG.
 */
export const MONITOR_CONFIG = {
  /** Interval pemeriksaan proses monitor. */
  intervalMs: 60_000,
  /** Alert yang masih aktif dikirim ulang setelah selang ini. */
  repeatAlertMs: 60 * 60_000,
  /** Snapshot pasar indexer lebih tua dari ini → indexer_lagging (UI sudah "delayed" di 3 menit). */
  indexerLagAlertMs: 10 * 60_000,
  /** Alamat indexer yang gagal berturut-turut sebanyak ini → indexer_errors. */
  indexerErrorAlertCount: 5,
  /** Launch job di submitting/confirming lebih lama dari ini → launch_stuck. */
  launchStuckAfterMs: 30 * 60_000,
  /** Batas waktu probe (DB/Redis/RPC/signer). */
  probeTimeoutMs: 3_000,
} as const;
