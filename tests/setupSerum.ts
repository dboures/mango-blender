import { BN } from "@project-serum/anchor";
import { DexInstructions, Market, TokenInstructions } from "@project-serum/serum";
import { getVaultOwnerAndNonce } from "@project-serum/swap/lib/utils";
import { SolanaProvider } from "@saberhq/solana-contrib";
import { MintInfo, Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TEST_PAYER, TEST_PROVIDER } from "./mango-blender";
import { SERUM_PROG_ID } from "./setupMango";

export interface MarketInfo {
  // dex accounts
  market: PublicKey;
  requestQueue: PublicKey;
  eventQueue: PublicKey;
  bids: PublicKey;
  asks: PublicKey;
  // vaults
  baseVault: PublicKey;
  quoteVault: PublicKey;
  // mints
  baseMint: PublicKey;
  quoteMint: PublicKey;
  // rest
  baseLotSize: BN;
  quoteLotSize: BN;
  feeRateBps: BN;
  vaultSignerNonce: PublicKey | BN;
  quoteDustThreshold: BN;
  programId: PublicKey;
}

export async function setupSpotMarket(
  baseMintPubkey: PublicKey,
  quoteMintPubkey: PublicKey,
  lotSize: number,
  tickSize: number
): Promise<MarketInfo> {
  const [
    marketPubkey,
    requestQueuePubkey,
    eventQueuePubkey,
    bidsPubkey,
    asksPubkey,
  ] = await createSerumAccountsForNewMarket();

  const [vaultOwnerPubkey, vaultNonce] = await getVaultOwnerAndNonce(
    marketPubkey,
    SERUM_PROG_ID
  );

  const [baseVaultPubkey, quoteVaultPubkey] = await prepareVaultAccounts(
    vaultOwnerPubkey as PublicKey,
    baseMintPubkey,
    quoteMintPubkey
  );

  const [baseLotSize, quoteLotSize] = await calcBaseAndQuoteLotSizes(
    lotSize,
    tickSize,
    baseMintPubkey,
    quoteMintPubkey
  );

  const feeRateBps = new BN(0);
  const quoteDustThreshold = new BN(100);

  const marketInfo = {
    market: marketPubkey,
    requestQueue: requestQueuePubkey,
    eventQueue: eventQueuePubkey,
    bids: bidsPubkey,
    asks: asksPubkey,
    baseVault: baseVaultPubkey,
    quoteVault: quoteVaultPubkey,
    baseMint: baseMintPubkey,
    quoteMint: quoteMintPubkey,
    baseLotSize,
    quoteLotSize,
    feeRateBps,
    vaultSignerNonce: vaultNonce,
    quoteDustThreshold,
    programId: SERUM_PROG_ID,
  };

  const initMarketInstruction = DexInstructions.initializeMarket(marketInfo);

  const transaction = new Transaction();
  transaction.add(initMarketInstruction);
  await TEST_PROVIDER.send(transaction);

  return marketInfo;
}

async function createSerumAccountsForNewMarket(): Promise<PublicKey[]> {
  const marketKeypair = new Keypair();
  const requestQueueKeypair = new Keypair();
  const eventQueueKeypair = new Keypair();
  const bidsKeypair = new Keypair();
  const asksKeypair = new Keypair();

  // length taken from here - https://github.com/project-serum/serum-dex/blob/master/dex/crank/src/lib.rs#L1286
  const marketInstruction = await prepareCreateStateAccountsInstruction(
    marketKeypair.publicKey,
    376 + 12
  );
  const requestQueueInstruction = await prepareCreateStateAccountsInstruction(
    requestQueueKeypair.publicKey,
    640 + 12
  );
  const eventQueueInstruction = await prepareCreateStateAccountsInstruction(
    eventQueueKeypair.publicKey,
    1048576 + 12
  );
  const bidsInstruction = await prepareCreateStateAccountsInstruction(
    bidsKeypair.publicKey,
    65536 + 12
  );
  const asksInstruction = await prepareCreateStateAccountsInstruction(
    asksKeypair.publicKey,
    65536 + 12
  );

  const transaction = new Transaction();
  transaction.add(marketInstruction);
  transaction.add(requestQueueInstruction);
  transaction.add(eventQueueInstruction);
  transaction.add(bidsInstruction);
  transaction.add(asksInstruction);

  await TEST_PROVIDER.send(transaction, [
    marketKeypair,
    requestQueueKeypair,
    eventQueueKeypair,
    bidsKeypair,
    asksKeypair,
  ]);

  return [
    marketKeypair.publicKey,
    requestQueueKeypair.publicKey,
    eventQueueKeypair.publicKey,
    bidsKeypair.publicKey,
    asksKeypair.publicKey,
  ];
}

async function prepareVaultAccounts(
  vaultOwnerPubkey: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey
): Promise<PublicKey[]> {
  const baseVaultKeypair = new Keypair();
  const quoteVaultKeypair = new Keypair();

  // as per https://github.com/project-serum/serum-dex-ui/blob/master/src/utils/send.tsx#L519
  const instructions = [
    SystemProgram.createAccount({
      fromPubkey: TEST_PROVIDER.wallet.publicKey,
      newAccountPubkey: baseVaultKeypair.publicKey,
      lamports:
        await TEST_PROVIDER.connection.getMinimumBalanceForRentExemption(165),
      space: 165,
      programId: TokenInstructions.TOKEN_PROGRAM_ID,
    }),
    SystemProgram.createAccount({
      fromPubkey: TEST_PROVIDER.wallet.publicKey,
      newAccountPubkey: quoteVaultKeypair.publicKey,
      lamports:
        await TEST_PROVIDER.connection.getMinimumBalanceForRentExemption(165),
      space: 165,
      programId: TokenInstructions.TOKEN_PROGRAM_ID,
    }),
    TokenInstructions.initializeAccount({
      account: baseVaultKeypair.publicKey,
      mint: baseMint,
      owner: vaultOwnerPubkey,
    }),
    TokenInstructions.initializeAccount({
      account: quoteVaultKeypair.publicKey,
      mint: quoteMint,
      owner: vaultOwnerPubkey,
    }),
  ];

  const transaction = new Transaction();
  transaction.add(...instructions);
  await TEST_PROVIDER.send(transaction, [baseVaultKeypair, quoteVaultKeypair]);

  return [baseVaultKeypair.publicKey, quoteVaultKeypair.publicKey];
}

async function calcBaseAndQuoteLotSizes(
  lotSize: number,
  tickSize: number,
  baseMintPubkey: PublicKey,
  quoteMintPubkey: PublicKey
): Promise<[BN, BN]> {
  let baseLotSize;
  let quoteLotSize;

  const baseMintInfo = await deserializeTokenMint(baseMintPubkey);
  const quoteMintInfo = await deserializeTokenMint(quoteMintPubkey);

  if (baseMintInfo && lotSize > 0) {
    baseLotSize = Math.round(10 ** baseMintInfo.decimals * lotSize);
    if (quoteMintInfo && tickSize > 0) {
      quoteLotSize = Math.round(
        lotSize * 10 ** quoteMintInfo.decimals * tickSize
      );
    }
  }
  if (!baseLotSize || !quoteLotSize) {
    throw new Error(
      `Failed to calculate base/quote lot sizes from lot size ${lotSize} and tick size ${tickSize}`
    );
  }

  return [new BN(baseLotSize), new BN(quoteLotSize)];
}

async function deserializeTokenMint(mintPubkey: PublicKey): Promise<MintInfo> {
  const t = new Token(
    TEST_PROVIDER.connection,
    mintPubkey,
    TOKEN_PROGRAM_ID,
    TEST_PAYER
  );
  return t.getMintInfo();
}

async function prepareCreateStateAccountsInstruction(
  stateAccountPubkey: PublicKey,
  space: number
): Promise<TransactionInstruction> {
  return SystemProgram.createAccount({
    programId: SERUM_PROG_ID,
    fromPubkey: TEST_PROVIDER.wallet.publicKey,
    newAccountPubkey: stateAccountPubkey,
    space,
    lamports: await TEST_PROVIDER.connection.getMinimumBalanceForRentExemption(
      space
    ),
  });
}

export async function consumeEvents(
  provider: SolanaProvider,
  market: Market,
  openOrdersPubkeys: PublicKey[]
): Promise<void> {
  const transaction = new Transaction();
  transaction.add(
    market.makeConsumeEventsInstruction(
      openOrdersPubkeys,
      100
    )
  );
  await provider.send(transaction);
}
