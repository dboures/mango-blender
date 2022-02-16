import {
  Cluster,
  Config,
  getOracleBySymbol,
  getSpotMarketByBaseSymbol,
  getTokenBySymbol,
  GroupConfig,
  MangoCache,
  MangoClient,
  MangoGroup,
  OracleConfig,
  RootBank,
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
import * as fs from "fs";
import { Market } from "@project-serum/serum";
import { TEST_PAYER, TEST_PROVIDER } from "./mango-blender";

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

export const MANGO_CONFIG_PATH = "./tests/fixtures/mangoConfig.json";

export async function createMangoGroup(
  
  
  quoteToken: Token
): Promise<PublicKey> {
  const client = new MangoClient(TEST_PROVIDER.connection, MANGO_PROG_ID);
  const feesVaultPubkey = await initializeFeeVault(quoteToken);

  const groupPubkey = await client.initMangoGroup(
    quoteToken.publicKey,
    zeroKey,
    SERUM_PROG_ID,
    feesVaultPubkey,
    validInterval,
    optimalUtil,
    optimalRate,
    maxRate,
    TEST_PAYER as unknown as Account
  );
  console.log("Mango Group initialized");

  const group = await client.getMangoGroup(groupPubkey);
  const rootBanks = await group.loadRootBanks(TEST_PROVIDER.connection);
  const tokenIndex = group.getTokenIndex(quoteToken.publicKey);
  const nodeBanks = await rootBanks[tokenIndex]?.loadNodeBanks(
    TEST_PROVIDER.connection
  );

  const tokenDesc = {
    symbol: "QUOTE",
    mintKey: quoteToken.publicKey,
    decimals: group.tokens[tokenIndex].decimals,
    rootKey: rootBanks[tokenIndex]?.publicKey as PublicKey,
    nodeKeys: nodeBanks?.map((n) => n?.publicKey) as PublicKey[],
  };

  const config = readConfig();
  const groupDesc: GroupConfig = {
    cluster: "localnet",
    name: "localnet.1",
    publicKey: groupPubkey,
    quoteSymbol: "QUOTE",
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
  decimals: number
): Promise<Token> {
  console.log("Creating token");
  return Token.createMint(
    TEST_PROVIDER.connection,
    TEST_PAYER as any,
    TEST_PAYER.publicKey,
    null,
    decimals,
    TOKEN_PROGRAM_ID
  );
}

export async function initializeProviderATA(
  token: Token,
  lots: number
) {
  // Create associated token accounts
  const createATAResult = await getOrCreateATA({
    provider: TEST_PROVIDER,
    mint: token.publicKey,
  });

  // Mint tokens
  const mintInstruction = createMintToInstruction({
    provider: TEST_PROVIDER,
    mint: token.publicKey,
    mintAuthorityKP: TEST_PAYER,
    to: createATAResult.address,
    amount: new u64(lots),
  });

  const transaction = new Transaction();
  if (createATAResult.instruction) {
    transaction.add(createATAResult.instruction);
  }
  transaction.add(...mintInstruction.instructions);
  await TEST_PROVIDER.send(transaction);
  return createATAResult.address;
}

async function initializeFeeVault(
  quoteToken: Token
): Promise<PublicKey> {
  console.log("Initializing fee vault");
  const balanceNeeded =
    await TEST_PROVIDER.connection.getMinimumBalanceForRentExemption(
      AccountLayout.span
    );

  const feeVaultKeypair = Keypair.generate();
  const createAccountsTransaction = new Transaction();
  createAccountsTransaction.add(
    SystemProgram.createAccount({
      fromPubkey: TEST_PAYER.publicKey,
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

  await TEST_PROVIDER.connection.sendTransaction(createAccountsTransaction, [
    TEST_PAYER,
    feeVaultKeypair,
  ]);
  console.log("Fee vault initialized");
  return feeVaultKeypair.publicKey;
}

function readConfig(): Config {
  return new Config(JSON.parse(fs.readFileSync(MANGO_CONFIG_PATH, "utf-8")));
}

function writeConfig(config: Config): void {
  fs.writeFileSync(MANGO_CONFIG_PATH, JSON.stringify(config.toJson(), null, 2));
}

export async function initPriceOracles(
  
  client: MangoClient,
  mangoGroupPubkey: PublicKey
): Promise<void> {
  await Promise.all([
    initPriceOracle(client, mangoGroupPubkey, "AAAA"),
    initPriceOracle(client, mangoGroupPubkey, "BBBB"),
  ]);
}

export async function initPriceOracle(
  client: MangoClient,
  mangoGroupPubkey: PublicKey,
  symbol: string
): Promise<void> {
  await client.addStubOracle(mangoGroupPubkey, TEST_PAYER as unknown as Account);
  const group = await client.getMangoGroup(mangoGroupPubkey);
  const config = readConfig();

  const oraclePk = group.oracles.find(g => !config.groups[0].oracles.map(c => c.publicKey.toBase58()).includes(g.toBase58()));
  const oracle = {
    symbol,
    publicKey: oraclePk
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

export async function setOraclePrice(
  
  client: MangoClient,
  symbol: string,
  price: number
) {
  const config = readConfig();
  const groupConfig = config.groups[0];
  const oracle = getOracleBySymbol(groupConfig, symbol) as OracleConfig;
  await client.setStubOracle(
    groupConfig.publicKey,
    oracle.publicKey,
    TEST_PAYER as unknown as Account,
    price
  );
}


export async function addSpotMarket(
  client: MangoClient,
  baseSymbol: string,
  spotMarket: PublicKey,
  baseMint: PublicKey,
): Promise<void> {
  const config = readConfig();
  const groupConfig = config.groups[0];

  let group = await client.getMangoGroup(groupConfig.publicKey);
  const oracleDesc = getOracleBySymbol(groupConfig, baseSymbol) as OracleConfig;

  await client.addSpotMarket(
    group,
    oracleDesc.publicKey,
    spotMarket,
    baseMint,
    TEST_PAYER as unknown as Account,
    maintLeverage,
    initLeverage,
    liquidationFee,
    optimalUtil,
    optimalRate,
    maxRate,
  );

  group = await client.getMangoGroup(groupConfig.publicKey);
  const market = await Market.load(
    TEST_PROVIDER.connection,
    spotMarket,
    undefined,
    groupConfig.serumProgramId,
  );
  const banks = await group.loadRootBanks(TEST_PROVIDER.connection);
  const tokenIndex = group.getTokenIndex(baseMint);
  const nodeBanks = await banks[tokenIndex]?.loadNodeBanks(TEST_PROVIDER.connection);

  const tokenDesc = {
    symbol: baseSymbol,
    mintKey: baseMint,
    decimals: group.tokens[tokenIndex].decimals,
    rootKey: banks[tokenIndex]?.publicKey as PublicKey,
    nodeKeys: nodeBanks?.map((n) => n?.publicKey) as PublicKey[],
  };

  try {
    const token = getTokenBySymbol(groupConfig, baseSymbol);
    Object.assign(token, tokenDesc);
  } catch (_) {
    groupConfig.tokens.push(tokenDesc);
  }

  const marketDesc = {
    name: `${baseSymbol}/${groupConfig.quoteSymbol}`,
    publicKey: spotMarket,
    baseSymbol,
    baseDecimals: market['_baseSplTokenDecimals'],
    quoteDecimals: market['_quoteSplTokenDecimals'],
    marketIndex: tokenIndex,
    bidsKey: market.bidsAddress,
    asksKey: market.asksAddress,
    eventsKey: market['_decoded'].eventQueue,
  };

  const marketConfig = getSpotMarketByBaseSymbol(groupConfig, baseSymbol);
  if (marketConfig) {
    Object.assign(marketConfig, marketDesc);
  } else {
    groupConfig.spotMarkets.push(marketDesc);
  }

  config.storeGroup(groupConfig);
  writeConfig(config);
  console.log(`${baseSymbol}/${groupConfig.quoteSymbol} spot market added`);
}


export async function keeperRefresh(client: MangoClient, mangoGroup: MangoGroup, mangoCache: MangoCache, rootBanks: RootBank[]): Promise<void> {
  const rootBankPubkeys = rootBanks
  .map((rb) => rb?.publicKey)
  .filter((pk) => pk !== undefined) as PublicKey[];

  await client.cacheRootBanks(
    mangoGroup.publicKey,
    mangoCache.publicKey,
    rootBankPubkeys,
    TEST_PAYER as unknown as Account
  );

  await client.cachePrices(mangoGroup.publicKey, mangoCache.publicKey, mangoGroup.oracles, TEST_PAYER as unknown as Account);
}