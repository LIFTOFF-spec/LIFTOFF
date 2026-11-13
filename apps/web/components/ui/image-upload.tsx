"use client";

import { useId, useState } from "react";
import { cn } from "./primitives";

const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export interface PickedImage {
  name: string;
  /** File asli; diunggah ke POST /api/uploads/image. */
  file: File;
  /** data URL untuk preview lokal. */
  dataUrl: string;
}

/**
 * Pilih gambar koin dengan preview lokal. Wizard mengunggahnya ke API, yang menghitung
 * perceptual hash untuk cek gambar salinan (Tahap 3).
 */
export function ImageUpload({
  value,
  onChange,
  error,
}: {
  value: PickedImage | null;
  onChange: (image: PickedImage | null) => void;
  error?: string | undefined;
}) {
  const id = useId();
  const [localError, setLocalError] = useState<string | null>(null);

  function pick(file: File | undefined) {
    setLocalError(null);
    if (!file) return;
    if (!ACCEPT.includes(file.type)) {
      setLocalError("Format must be PNG, JPG, WebP, or GIF.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setLocalError("Maximum size is 2 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string")
        onChange({ name: file.name, file, dataUrl: reader.result });
    };
    reader.onerror = () => setLocalError("Could not read the file.");
    reader.readAsDataURL(file);
  }

  const shownError = localError ?? error;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">
        Image <span className="text-text-subtle">*</span>
      </span>
      <div className="flex items-center gap-3">
        <label
          htmlFor={id}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            pick(e.dataTransfer.files[0]);
          }}
          className={cn(
            "relative flex size-24 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 border-dashed bg-surface text-center text-xs text-text-subtle transition hover:border-ink",
            shownError ? "border-danger/70" : "border-line-strong",
          )}
        >
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element -- preview data URL lokal
            <img src={value.dataUrl} alt="Coin image preview" className="size-full object-cover" />
          ) : (
            <span className="px-2">Choose or drop an image</span>
          )}
        </label>
        <input
          id={id}
          type="file"
          accept={ACCEPT.join(",")}
          className="sr-only"
          aria-invalid={Boolean(shownError)}
          aria-describedby={`${id}-help`}
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <div id={`${id}-help`} className="min-w-0 text-xs text-text-subtle">
          {value ? (
            <>
              <span className="block truncate text-text">{value.name}</span>
              <button
                type="button"
                className="mt-1 text-text-muted underline hover:text-text"
                onClick={() => onChange(null)}
              >
                Remove
              </button>
            </>
          ) : (
            <span>
              PNG/JPG/WebP/GIF, max 2 MB. Images that closely match another coin (resized or
              recolored) are rejected.
            </span>
          )}
        </div>
      </div>
      {shownError && (
        <p role="alert" className="text-xs text-danger">
          {shownError}
        </p>
      )}
    </div>
  );
}
