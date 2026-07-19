/**
 * Static configuration: TxLINE networks and engine paths.
 * Select the network with PROOFDESK_NETWORK=devnet|mainnet (default devnet).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

export type Network = "devnet" | "mainnet";

export interface NetworkConfig {
  network: Network;
  rpcUrl: string;
  apiOrigin: string;
  apiBaseUrl: string;
  jwtUrl: string;
  programId: string;
  txlTokenMint: string;
  explorerCluster: string;
}

const NETWORKS: Record<Network, NetworkConfig> = {
  devnet: {
    network: "devnet",
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    apiOrigin: "https://txline-dev.txodds.com",
    apiBaseUrl: "https://txline-dev.txodds.com/api",
    jwtUrl: "https://txline-dev.txodds.com/auth/guest/start",
    programId: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
    txlTokenMint: "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG",
    explorerCluster: "?cluster=devnet",
  },
  mainnet: {
    network: "mainnet",
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    apiOrigin: "https://txline.txodds.com",
    apiBaseUrl: "https://txline.txodds.com/api",
    jwtUrl: "https://txline.txodds.com/auth/guest/start",
    programId: "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA",
    txlTokenMint: "Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL",
    explorerCluster: "",
  },
};

export function activeNetwork(): NetworkConfig {
  const name = (process.env.PROOFDESK_NETWORK ?? "devnet") as Network;
  const cfg = NETWORKS[name];
  if (!cfg) throw new Error(`Unknown PROOFDESK_NETWORK "${name}" (use devnet or mainnet)`);
  return cfg;
}

export const DATA_DIR = process.env.PROOFDESK_DATA_DIR ?? path.join(ROOT, "data");
export const DB_PATH = path.join(DATA_DIR, "proofdesk.db");
export const CREDENTIALS_PATH = path.join(DATA_DIR, "credentials.json");
export const POLICY_PATH = process.env.PROOFDESK_POLICY ?? path.join(DATA_DIR, "policy.json");
export const KEYPAIR_PATH = process.env.PROOFDESK_KEYPAIR ?? path.join(DATA_DIR, "wallet.json");

export const DASHBOARD_PORT = Number(process.env.PROOFDESK_PORT ?? 8787);
/** How often we commit accumulated desk activity to Solana (ms). */
export const ANCHOR_INTERVAL_MS = Number(process.env.PROOFDESK_ANCHOR_INTERVAL_MS ?? 60_000);
/** Memo program (SPL Memo v2) used for anchoring. */
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
