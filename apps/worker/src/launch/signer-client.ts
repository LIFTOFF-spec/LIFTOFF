import type {
  SignerErrorBody,
  SignerMintResponse,
  SignerSignResponse,
  SignPurpose,
} from "@liftoff/shared";
import { SignerClientError, type SignerClient } from "./ports";

/** Klien HTTP internal ke apps/signer. Token tidak pernah di-log. */
export class HttpSignerClient implements SignerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly authToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SignerClientError(
        "network",
        `signer tidak terjangkau: ${(err as Error).message}`,
        true,
      );
    }
    const json = (await res.json().catch(() => null)) as (T & Partial<SignerErrorBody>) | null;
    if (!res.ok || !json || json.error) {
      const e = json?.error;
      throw new SignerClientError(
        e?.code ?? "internal",
        e?.message ?? `signer HTTP ${res.status}`,
        e?.retryable ?? res.status >= 500,
      );
    }
    return json;
  }

  deriveMint(jobId: string) {
    return this.post<SignerMintResponse>("/v1/launch/mint", { jobId });
  }

  sign(p: { purpose: SignPurpose; jobId?: string; opId?: string; transaction: string }) {
    return this.post<SignerSignResponse>("/v1/sign", p);
  }
}
