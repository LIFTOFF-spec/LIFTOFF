import type { ApiError, ValidationReason } from "@liftoff/shared";

/** Error yang dikembalikan ke klien apa adanya (kode + pesan yang bisa dibaca pengguna). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly reasons?: ValidationReason[],
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }

  toBody(): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.reasons ? { reasons: this.reasons } : {}),
      },
    };
  }
}
