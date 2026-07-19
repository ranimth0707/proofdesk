/**
 * One-time TxLINE free-tier activation (World Cup bundle).
 *
 * Flow (mirrors TxODDS' own devnet example, examples/devnet/common/users.ts):
 *   1. load/create the desk wallet (data/wallet.json)
 *   2. POST /auth/guest/start                      → guest JWT
 *   3. on-chain `subscribe(serviceLevel, 4 weeks)` → txSig  (free tier: no
 *      TxL transfer, only Solana fees)
 *   4. sign `${txSig}::${jwt}` with the same wallet (ed25519, base64)
 *   5. POST /api/token/activate                    → long-lived API token
 *   6. persist data/credentials.json
 *
 * Usage:
 *   PROOFDESK_NETWORK=devnet  npm run activate            (service level 1)
 *   PROOFDESK_NETWORK=mainnet SERVICE_LEVEL=12 npm run activate   (real-time)
 */

import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { CREDENTIALS_PATH, activeNetwork } from "../src/config.js";
import { saveCredentials } from "../src/txline/auth.js";
import { connection, loadOrCreateKeypair, oracleProgram } from "../src/solana.js";
import { makeLog } from "../src/log.js";

const log = makeLog("activate");

const SERVICE_LEVEL = Number(process.env.SERVICE_LEVEL ?? 1);
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES: number[] = []; // standard free bundle

async function main(): Promise<void> {
  const net = activeNetwork();
  log.info(`activating on ${net.network} — service level ${SERVICE_LEVEL}, ${DURATION_WEEKS} weeks`);

  const keypair = loadOrCreateKeypair();
  const conn = connection();
  const balance = await conn.getBalance(keypair.publicKey);
  log.info(`wallet ${keypair.publicKey.toBase58()} balance ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 5_000_000) {
    throw new Error(
      `Wallet needs SOL for the subscribe transaction fees/rent (have ${balance / 1e9}). ` +
        (net.network === "devnet"
          ? "Get devnet SOL from https://faucet.solana.com for this address."
          : "Send ~0.01 SOL to this address.")
    );
  }

  const program = oracleProgram(keypair, conn);
  const tokenMint = new PublicKey(net.txlTokenMint);

  // 1. guest JWT
  const jwtRes = await fetch(net.jwtUrl, { method: "POST" });
  if (!jwtRes.ok) throw new Error(`guest JWT failed: HTTP ${jwtRes.status}`);
  const jwt = ((await jwtRes.json()) as { token: string }).token;
  log.info("guest JWT acquired");

  // 2. ensure Token-2022 ATA exists (required by subscribe even on free tier)
  const userTokenAccount = getAssociatedTokenAddressSync(
    tokenMint, keypair.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const ataInfo = await conn.getAccountInfo(userTokenAccount);
  if (!ataInfo) {
    log.info("creating TxL Token-2022 associated token account");
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        keypair.publicKey, userTokenAccount, keypair.publicKey, tokenMint,
        TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(conn, tx, [keypair], { commitment: "confirmed" });
    await new Promise((r) => setTimeout(r, 3000));
  }

  // 3. on-chain subscribe
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")], program.programId
  );
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")], program.programId
  );
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    tokenMint, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const matrix = await (program.account as any).pricingMatrix.fetch(pricingMatrixPda);
  log.info("pricing matrix rows:");
  for (const row of matrix.rows as any[]) {
    log.info(
      `  level ${row.rowId}: ${row.pricePerWeekToken} TxL/week, sampling ${row.samplingIntervalSec}s`
    );
  }

  log.info(`sending subscribe(${SERVICE_LEVEL}, ${DURATION_WEEKS})…`);
  const txSig = await (program.methods as any)
    .subscribe(SERVICE_LEVEL, DURATION_WEEKS)
    .accounts({
      user: keypair.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  log.info("subscribe confirmed:", txSig);

  // 4. activation signature over `${txSig}::${jwt}` (empty league list)
  const message = new TextEncoder().encode(`${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`);
  const walletSignature = Buffer.from(nacl.sign.detached(message, keypair.secretKey)).toString("base64");

  // 5. activate
  const actRes = await fetch(`${net.apiBaseUrl}/token/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ txSig, walletSignature, leagues: SELECTED_LEAGUES }),
  });
  if (!actRes.ok) {
    throw new Error(`activation failed: HTTP ${actRes.status} ${(await actRes.text()).slice(0, 300)}`);
  }
  const actBody = (await actRes.json().catch(() => null)) as { token?: string } | string | null;
  const apiToken =
    typeof actBody === "string" ? actBody : actBody?.token ?? (await actRes.text());
  if (!apiToken) throw new Error("activation returned no token");

  saveCredentials({
    network: net.network,
    apiToken,
    jwt,
    walletPubkey: keypair.publicKey.toBase58(),
    subscribeTxSig: txSig,
    activatedAt: new Date().toISOString(),
  });
  log.info(`API token activated and saved to ${CREDENTIALS_PATH}`);
  log.info("done — run `npm start` to launch the desk");
}

main().catch((e) => {
  log.error(e);
  process.exit(1);
});
