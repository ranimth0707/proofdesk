/**
 * TxLINE credential management.
 *
 * Two tokens are in play (see TxLINE quickstart):
 *   - guest JWT  — short-lived session token from POST /auth/guest/start,
 *                  sent as `Authorization: Bearer <jwt>`; renewed on 401.
 *   - API token  — long-lived entitlement obtained once via the on-chain
 *                  subscribe + activation signature flow, sent as
 *                  `X-Api-Token`. Persisted in data/credentials.json.
 *
 * The one-time activation itself lives in scripts/activate.ts (it needs the
 * Solana wallet); the runtime engine only ever renews JWTs.
 */

import fs from "node:fs";
import path from "node:path";
import { CREDENTIALS_PATH, activeNetwork } from "../config.js";
import { makeLog } from "../log.js";

const log = makeLog("auth");

export interface Credentials {
  network: string;
  apiToken: string;
  jwt: string;
  walletPubkey?: string;
  subscribeTxSig?: string;
  activatedAt?: string;
}

export class AuthManager {
  private creds: Credentials;
  private renewing: Promise<string> | null = null;

  constructor(credentialsPath: string = CREDENTIALS_PATH) {
    this.path = credentialsPath;
    if (!fs.existsSync(credentialsPath)) {
      throw new Error(
        `No TxLINE credentials at ${credentialsPath}. Run \`npm run activate\` first ` +
          `(subscribes on-chain and activates an API token for the free World Cup tier).`
      );
    }
    this.creds = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as Credentials;
    const net = activeNetwork().network;
    if (this.creds.network !== net) {
      throw new Error(
        `Credentials in ${credentialsPath} are for network "${this.creds.network}" but ` +
          `PROOFDESK_NETWORK=${net}. Tokens are network-bound; re-run activation.`
      );
    }
    if (!this.creds.apiToken) throw new Error(`Credentials file has no apiToken; re-run activation.`);
  }

  private path: string;

  get apiToken(): string {
    return this.creds.apiToken;
  }

  get jwt(): string {
    return this.creds.jwt;
  }

  headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.creds.jwt}`,
      "X-Api-Token": this.creds.apiToken,
    };
  }

  /** Renew the guest JWT (single-flight: concurrent callers share one renewal). */
  async renewJwt(): Promise<string> {
    if (this.renewing) return this.renewing;
    this.renewing = (async () => {
      const { jwtUrl } = activeNetwork();
      log.info("renewing guest JWT from", jwtUrl);
      const res = await fetch(jwtUrl, { method: "POST" });
      if (!res.ok) throw new Error(`guest JWT renewal failed: HTTP ${res.status}`);
      const body = (await res.json()) as { token?: string };
      if (!body.token) throw new Error("guest JWT renewal returned no token");
      this.creds.jwt = body.token;
      this.persist();
      return body.token;
    })();
    try {
      return await this.renewing;
    } finally {
      this.renewing = null;
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify(this.creds, null, 2));
  }
}

/** Used by scripts/activate.ts to write the credential file. */
export function saveCredentials(creds: Credentials, credentialsPath: string = CREDENTIALS_PATH): void {
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify(creds, null, 2));
}
