import {
  Cluster,
  Config,
  getOracleBySymbol,
  GroupConfig,
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
import { AccountLayout, Token, TOKEN_PROGRAM_ID, u64 } from "@solana/spl-token";
import { createMintToInstruction, getOrCreateATA } from "@saberhq/token-utils";
import * as fs from 'fs';

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

export const MANGO_CONFIG_PATH = './tests/fixtures/mangoConfig.json';

export async function createMangoGroup(
  provider: SolanaProvider,
  payer: Keypair,
  quoteToken: Token
): Promise<PublicKey> {
  const client = new MangoClient(provider.connection, MANGO_PROG_ID);
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

  const group = await client.getMangoGroup(groupPubkey);
  const rootBanks = await group.loadRootBanks(provider.connection);
  const tokenIndex = group.getTokenIndex(quoteToken.publicKey);
  const nodeBanks = await rootBanks[tokenIndex]?.loadNodeBanks(provider.connection);

  const tokenDesc = {
    symbol: 'QUOTE',
    mintKey: quoteToken.publicKey,
    decimals: group.tokens[tokenIndex].decimals,
    rootKey: rootBanks[tokenIndex]?.publicKey as PublicKey,
    nodeKeys: nodeBanks?.map((n) => n?.publicKey) as PublicKey[],
  };

  const config = readConfig();
  const groupDesc: GroupConfig = {
    cluster: 'localnet',
    name: 'localnet.1',
    publicKey: groupPubkey,
    quoteSymbol: 'QUOTE',
    mangoProgramId: MANGO_PROG_ID,
    serumProgramId: SERUM_PROG_ID,
    tokens: [tokenDesc],
    oracles: [],
    perpMarkets: [],
    spotMarkets: [],
  };

  config.storeGroup(groupDesc);
  writeConfig(config);
  return groupPubkey;
}

export async function createToken(
  provider: SolanaProvider,
  payer: Keypair,
  decimals: number
): Promise<Token> {
  console.log("Creating token");
  return Token.createMint(
    provider.connection,
    payer as any,
    payer.publicKey,
    null,
    decimals,
    TOKEN_PROGRAM_ID
  );
}

export async function initializeProviderATA(provider: SolanaProvider, payer: Keypair, token: Token, lots: number) {
    // Create associated token accounts
    const createATAResult = await getOrCreateATA({
      provider: provider,
      mint: token.publicKey,
    });

    // Mint tokens
    const mintInstruction = createMintToInstruction({
      provider: provider,
      mint: token.publicKey,
      mintAuthorityKP: payer,
      to: createATAResult.address,
      amount: new u64(lots),
    });

    const transaction = new Transaction();
    if (createATAResult.instruction) {
      transaction.add(createATAResult.instruction);
    }
    transaction.add(...mintInstruction.instructions);
    await provider.send(transaction);
    return createATAResult.address
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

function readConfig(): Config {
  return new Config(JSON.parse(fs.readFileSync(MANGO_CONFIG_PATH, 'utf-8')));
}

function writeConfig(config: Config): void {
  fs.writeFileSync(MANGO_CONFIG_PATH, JSON.stringify(config.toJson(), null, 2));
}


export async function initPriceOracles(payer: Keypair, client: MangoClient, mangoGroupPubkey: PublicKey) : Promise<void> {
  await Promise.all([
    initPriceOracle(payer, client, mangoGroupPubkey, 'AAAA'),
    initPriceOracle(payer, client, mangoGroupPubkey, 'BBBB'),
  ])
}


export async function initPriceOracle(payer: Keypair, client: MangoClient, mangoGroupPubkey: PublicKey, symbol: string): Promise<void> {
  await client.addStubOracle(
    mangoGroupPubkey, payer as unknown as Account,
  );
  const group = await client.getMangoGroup(mangoGroupPubkey);
    const config = readConfig();

    const oracle = {
      symbol,
      publicKey: group.oracles[group.numOracles - 1],
    };
    const foundOracle = getOracleBySymbol(config.groups[0], symbol);
    if (foundOracle) {
      Object.assign(foundOracle, oracle);
    } else {
      config.groups[0].oracles.push(oracle);
    }
    console.log(`${symbol} price oracle added`);
    writeConfig(config);
}

// async function setOraclePrice(payer: Keypair, client: MangoClient, mangoGroupPubkey: PublicKey, price: number) {
//   const group = await client.getMangoGroup(mangoGroupPubkey);
//   group.oracles

  
//   const groupConfig = config.groups[0];
//   await client.setStubOracle(
//     groupConfig.publicKey,
//     oracle.publicKey,
//     payer as unknown as Account,
//     price,
//   );
// }