"use client";

import { useSyncExternalStore } from "react";

// Jam bersama untuk hitung mundur & waktu relatif. Di server bernilai null
// sehingga render awal tidak bergantung pada waktu (hindari hydration mismatch).

const listeners = new Set<() => void>();
let now = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number | null {
  if (now === 0) now = Date.now();
  return now;
}

function getServerSnapshot(): number | null {
  return null;
}

/** Waktu sekarang (ms), diperbarui tiap detik. `null` saat SSR/hydration. */
export function useNow(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const noopSubscribe = () => () => {};

/** `true` setelah komponen berjalan di browser. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
