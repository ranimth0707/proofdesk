/**
 * Solana wiring: wallet keypair, connection, and the TxLINE oracle program.
 * The desk wallet self-provisions on first boot (Aegis-style): if no keypair
 * exists at KEYPAIR_PATH a fresh one is generated and persisted.
 */

import fs from "node:fs";
import path from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { KEYPAIR_PATH, activeNetwork } from "./config.js";
import { makeLog } from "./log.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const log = makeLog("solana");

export function loadOrCreateKeypair(keypairPath: string = KEYPAIR_PATH): Keypair {
  if (fs.existsSync(keypairPath)) {
    const raw = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
    if (Array.isArray(raw)) return Keypair.fromSecretKey(Uint8Array.from(raw));
    if (raw.secretKeyBase58) {
      const bs58 = require("bs58");
      const decode = (bs58.default ?? bs58).decode;
      return Keypair.fromSecretKey(decode(raw.secretKeyBase58));
    }
    throw new Error(`Unrecognized keypair format at ${keypairPath}`);
  }
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(keypairPath), { recursive: true });
  fs.writeFileSync(keypairPath, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  log.info("generated new desk wallet:", kp.publicKey.toBase58());
  return kp;
}

export function connection(): Connection {
  return new Connection(activeNetwork().rpcUrl, "confirmed");
}

/** The TxLINE oracle Anchor program bound to the desk wallet. */
export function oracleProgram(keypair: Keypair, conn: Connection): anchor.Program {
  const net = activeNetwork();
  const idlPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "idl",
    `txoracle.${net.network}.json`
  );
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);
  const expected = new PublicKey(net.programId);
  if (!program.programId.equals(expected)) {
    throw new Error(
      `IDL program ${program.programId.toBase58()} does not match ${net.network} program ${net.programId}`
    );
  }
  return program;
}

export function explorerTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}${activeNetwork().explorerCluster}`;
}
