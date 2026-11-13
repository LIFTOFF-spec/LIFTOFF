/**
 * Upload gambar koin + perceptual hash (P4).
 *
 * Gambar di-decode dan di-encode ulang ke WebP 512×512 (metadata dibuang), lalu pHash dihitung
 * dari hasil encode ulang itu sehingga hash selalu bisa dihitung ulang dari file yang tersimpan.
 * Penyimpanan lokal (`UPLOAD_DIR`) untuk development; object storage menyusul (Tahap 9).
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PHASH_SIZE, perceptualHash } from "@liftoff/shared";
import sharp from "sharp";

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const IMAGE_SIZE = 512;
/**
 * Batas piksel saat decode (Tahap 9): file 2 MB bisa mengembang jadi gambar raksasa
 * ("decompression bomb"). Default sharp ±268 MP terlalu longgar untuk avatar 512×512.
 */
export const IMAGE_MAX_INPUT_PIXELS = 25_000_000;

export async function hashImage(input: Buffer): Promise<string> {
  const { data } = await sharp(input, { limitInputPixels: IMAGE_MAX_INPUT_PIXELS })
    .flatten({ background: "#ffffff" })
    .grayscale()
    .resize(PHASH_SIZE, PHASH_SIZE, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return perceptualHash(data);
}

export class ImageStore {
  constructor(private readonly dir: string) {}

  private path(ref: string) {
    if (!/^[0-9a-f]{32}$/.test(ref)) throw new Error("invalid image ref");
    return join(this.dir, `${ref}.webp`);
  }

  /** Menyimpan gambar; melempar jika bukan gambar yang valid. */
  async save(input: Buffer): Promise<{ ref: string; hash: string }> {
    const meta = await sharp(input, {
      animated: false,
      limitInputPixels: IMAGE_MAX_INPUT_PIXELS,
    }).metadata();
    if (!meta.width || !meta.height || meta.width < 64 || meta.height < 64) {
      throw new Error("image_too_small");
    }
    const webp = await sharp(input, { animated: false, limitInputPixels: IMAGE_MAX_INPUT_PIXELS })
      .rotate()
      .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "cover" })
      .webp({ quality: 85 })
      .toBuffer();
    const ref = randomBytes(16).toString("hex");
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(ref), webp);
    return { ref, hash: await hashImage(webp) };
  }

  async read(ref: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(ref));
    } catch {
      return null;
    }
  }

  async hash(ref: string): Promise<string | null> {
    const file = await this.read(ref);
    return file ? hashImage(file) : null;
  }

  static url(ref: string) {
    return `/api/uploads/${ref}.webp`;
  }
}
