import { describe, expect, it } from "vitest";
import { LAUNCH_STATUSES, type LaunchStatus } from "./api";
import {
  assertTransition,
  canTransition,
  InvalidLaunchTransition,
  isFinalLaunchStatus,
  LAUNCH_TRANSITIONS,
} from "./launch-state";

// Tabel lengkap: setiap pasangan (from, to) yang diizinkan. Semua pasangan lain wajib ditolak.
const ALLOWED: Array<[LaunchStatus, LaunchStatus]> = [
  ["validating", "queued"],
  ["validating", "failed"],
  ["queued", "submitting"],
  ["queued", "failed"],
  ["submitting", "confirming"],
  ["submitting", "queued"],
  ["submitting", "failed"],
  ["submitting", "needs_reconciliation"],
  ["confirming", "live"],
  ["confirming", "submitting"],
  ["confirming", "failed"],
  ["confirming", "needs_reconciliation"],
  ["needs_reconciliation", "live"],
  ["needs_reconciliation", "confirming"],
  ["needs_reconciliation", "submitting"],
  ["needs_reconciliation", "failed"],
];

const key = (from: LaunchStatus, to: LaunchStatus) => `${from}→${to}`;
const allowedSet = new Set(ALLOWED.map(([f, t]) => key(f, t)));

describe("launch state machine", () => {
  const pairs = LAUNCH_STATUSES.flatMap((from) => LAUNCH_STATUSES.map((to) => [from, to] as const));

  it.each(pairs)("%s → %s sesuai tabel", (from, to) => {
    const expected = allowedSet.has(key(from, to));
    expect(canTransition(from, to)).toBe(expected);
    if (expected) expect(() => assertTransition(from, to)).not.toThrow();
    else expect(() => assertTransition(from, to)).toThrow(InvalidLaunchTransition);
  });

  it("tabel di kode sama persis dengan tabel test", () => {
    const fromCode = Object.entries(LAUNCH_TRANSITIONS).flatMap(([f, tos]) =>
      tos.map((t) => key(f as LaunchStatus, t)),
    );
    expect(new Set(fromCode)).toEqual(allowedSet);
  });

  it("live dan failed final, tidak ada jalan keluar", () => {
    expect(isFinalLaunchStatus("live")).toBe(true);
    expect(isFinalLaunchStatus("failed")).toBe(true);
    expect(LAUNCH_TRANSITIONS.live).toEqual([]);
    expect(LAUNCH_TRANSITIONS.failed).toEqual([]);
    for (const s of ["validating", "queued", "submitting", "confirming", "needs_reconciliation"]) {
      expect(isFinalLaunchStatus(s as LaunchStatus)).toBe(false);
    }
  });

  it("live hanya bisa dicapai dari confirming atau needs_reconciliation", () => {
    const into = LAUNCH_STATUSES.filter((s) => canTransition(s, "live"));
    expect(into.sort()).toEqual(["confirming", "needs_reconciliation"]);
  });

  it("tidak ada self-transition", () => {
    for (const s of LAUNCH_STATUSES) expect(canTransition(s, s)).toBe(false);
  });
});
