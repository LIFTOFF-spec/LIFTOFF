/**
 * Login X (Twitter) OAuth 2.0 Authorization Code + PKCE.
 *
 * Hanya identitas (id + username) yang dipakai; access token X TIDAK disimpan.
 * Dokumentasi: https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code
 */
import { createHash, randomBytes } from "node:crypto";
import type { XOAuthConfig } from "../config";

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
export const X_ME_URL = "https://api.x.com/2/users/me";
export const X_SCOPES = ["users.read", "tweet.read"];

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkce(): PkcePair {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(config: XOAuthConfig, state: string, challenge: string): string {
  const url = new URL(X_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: X_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export interface XIdentity {
  id: string;
  username: string;
}

/** Menukar authorization code dengan access token, lalu membaca identitas user. */
export async function exchangeCodeForIdentity(
  config: XOAuthConfig,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<XIdentity> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const tokenRes = await fetchImpl(X_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.callbackUrl,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok) throw new Error(`X token endpoint: HTTP ${tokenRes.status}`);
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error("X token endpoint: access_token kosong");

  const meRes = await fetchImpl(X_ME_URL, {
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!meRes.ok) throw new Error(`X users/me: HTTP ${meRes.status}`);
  const me = (await meRes.json()) as { data?: { id?: string; username?: string } };
  if (!me.data?.id || !me.data.username) throw new Error("X users/me: data tidak lengkap");
  return { id: me.data.id, username: me.data.username };
}
