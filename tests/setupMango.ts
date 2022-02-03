import {
  Cluster,
  MangoClient,
  zeroKey,
} from "@blockworks-foundation/mango-client";
import { SolanaProvider } from "@saberhq/solana-contrib";
import {
  Account,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { AccountLayout, Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";

// These params typically differ across currencies (and Spot vs Perp) based on risk
// Since this is just for simple testing, it's ok to reuse them for everything
const validInterval = 100; // the interval where caches are no longer valid (UNIX timestamp)
const optimalUtil = 0.7; // optimal utilization interest rate param for currency
const optimalRate = 0.06; // optimal interest rate param for currency
const maxRate = 1.5; // max interest rate param for currency
const maintLeverage = 20; // max leverage, if you exceed this you will be liquidated
const initLeverage = 10; // largest leverage at which you can open a position
const liquidationFee = 0.05;
const groupName = "localnet.1";

export const SERUM_PROG_ID = new PublicKey(
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
);
export const MANGO_PROG_ID = new PublicKey(
  "mv3ekLzLbnVPNxjSKvqBpU3ZeZXPQdEC3bp5MDEBG68"
);

export async function createMangoGroup(
  provider: SolanaProvider,
  payer: Keypair
): Promise<PublicKey> {
  const client = new MangoClient(provider.connection, MANGO_PROG_ID);
  const quoteToken = await createQuoteToken(provider, payer);
  const feesVaultPubkey = await initializeFeeVault(provider, payer, quoteToken);

  const groupPubkey = await client.initMangoGroup(
    quoteToken.publicKey,
    zeroKey,
    SERUM_PROG_ID,
    feesVaultPubkey,
    validInterval,
    optimalUtil,
    optimalRate,
    maxRate,
    payer as unknown as Account
  );
  console.log("Mango Group initialized");
  return groupPubkey;
}

async function createQuoteToken(
  provider: SolanaProvider,
  payer: Keypair
): Promise<Token> {
  console.log("Creating quote token");
  return Token.createMint(
    provider.connection,
    payer as any,
    payer.publicKey,
    null,
    0,
    TOKEN_PROGRAM_ID
  );
}

async function initializeFeeVault(
  provider: SolanaProvider,
  payer: Keypair,
  quoteToken: Token
): Promise<PublicKey> {
  console.log("Initializing fee vault");
  const balanceNeeded = await provider.connection.getMinimumBalanceForRentExemption(
    AccountLayout.span,
  );

  const feeVaultKeypair = Keypair.generate();
  const createAccountsTransaction = new Transaction();
  createAccountsTransaction.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: feeVaultKeypair.publicKey,
      lamports: balanceNeeded,
      space: AccountLayout.span,
      programId: TOKEN_PROGRAM_ID,
    })
  );
  createAccountsTransaction.add(
    Token.createInitAccountInstruction(
      TOKEN_PROGRAM_ID,
      quoteToken.publicKey,
      feeVaultKeypair.publicKey,
      TOKEN_PROGRAM_ID
    )
  );

  await provider.connection.sendTransaction(createAccountsTransaction, [
    payer,
    feeVaultKeypair,
  ]);
  console.log("Fee vault initialized");
  return feeVaultKeypair.publicKey;
}
