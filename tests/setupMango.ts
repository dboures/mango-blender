import {
  BN,
  Cluster,
  Config,
  createAccountInstruction,
  getOracleBySymbol,
  getPerpMarketByBaseSymbol,
  getSpotMarketByBaseSymbol,
  getTokenBySymbol,
  GroupConfig,
  makeInitSpotOpenOrdersInstruction,
  makePlaceSpotOrderInstruction,
  MangoAccount,
  MangoCache,
  MangoClient,
  MangoGroup,
  nativeToUi,
  OracleConfig,
  QUOTE_INDEX,
  RootBank,
  uiToNative,
  WalletAdapter,
  zeroKey,
  ZERO_BN,
} from "@blockworks-foundation/mango-client";
import { SolanaProvider } from "@saberhq/solana-contrib";
import {
  Account,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionSignature,
} from "@solana/web3.js";
import { AccountLayout, Token, TOKEN_PROGRAM_ID, u64 } from "@solana/spl-token";
import { createMintToInstruction, getOrCreateATA } from "@saberhq/token-utils";
import * as fs from "fs";
import { getFeeRates, getFeeTier, Market, OpenOrders } from "@project-serum/serum";
import { TEST_PAYER, TEST_PROVIDER } from "./mango-blender";

// These params typically differ across currencies (and Spot vs Perp) based on risk
// Since this is just for simple testing, it's ok to reuse them for everything
const validInterval = 10000; // the interval where caches are no longer valid (UNIX timestamp)
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
  provider: SolanaProvider,
  tokenPubkey: PublicKey,
  lots: number,
  mintTokens = true
) {
  const transaction = new Transaction();
  // Create associated token accounts
  const createATAResult = await getOrCreateATA({
    provider: provider,
    mint: tokenPubkey,
  });
  if (createATAResult.instruction) {
    transaction.add(createATAResult.instruction);
  }

  if (mintTokens) {
    const mintInstruction = createMintToInstruction({
      provider: provider,
      mint: tokenPubkey,
      mintAuthorityKP: TEST_PAYER,
      to: createATAResult.address,
      amount: new u64(lots),
    });
    transaction.add(...mintInstruction.instructions);
    await provider.send(transaction, [TEST_PAYER]);
  } else {
    await provider.send(transaction);
  }
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

export function readConfig(): Config {
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

  // The Mango program has mintPk hardcoded in, the mint check must be disabled for local testing
  // https://github.com/blockworks-foundation/mango-v3/blob/408e0bc44e42b344fb6e9c1c127d39d0569c567f/program/src/state.rs#L2127
  export async function addPerpMarket(
    client: MangoClient,
    symbol: string,
    mngoMintPubkey: PublicKey,
  ) {
    const config = readConfig();
    const groupConfig = config.groups[0];

    let group = await client.getMangoGroup(groupConfig.publicKey);
    const makerFee = 0.0;
    const takerFee = 0.0005;
    const baseLotSize = 1000000;
    const quoteLotSize = 100000;
    const maxNumEvents = 256;
    const rate = 0;
    const maxDepthBps = 200;
    const targetPeriodLength = 3600;
    const mngoPerPeriod = 0;

    const oracleDesc = getOracleBySymbol(groupConfig, symbol) as OracleConfig;
    const marketIndex = group.getOracleIndex(oracleDesc.publicKey);

    // Adding perp market
    let nativeMngoPerPeriod = 0;
    if (rate !== 0) {
      const token = getTokenBySymbol(groupConfig, 'MNGO');
      if (token === undefined) {
        throw new Error('MNGO not found in group config');
      } else {
        nativeMngoPerPeriod = uiToNative(
          mngoPerPeriod,
          token.decimals,
        ).toNumber();
      }
    }

    await client.createPerpMarket(
      group,
      oracleDesc.publicKey,
      mngoMintPubkey,
      TEST_PAYER as unknown as Account,
      maintLeverage,
      initLeverage,
      liquidationFee,
      makerFee,
      takerFee,
      baseLotSize,
      quoteLotSize,
      maxNumEvents,
      rate,
      maxDepthBps,
      targetPeriodLength,
      nativeMngoPerPeriod,
      1,
      1,
      0,
      6
    );

    group = await client.getMangoGroup(groupConfig.publicKey);
    const perpMarketPubkey = group.perpMarkets[marketIndex].perpMarket;
    const baseDecimals = getTokenBySymbol(groupConfig, symbol)
      ?.decimals as number;
    const quoteDecimals = getTokenBySymbol(groupConfig, groupConfig.quoteSymbol)
      ?.decimals as number;
    const market = await client.getPerpMarket(
      perpMarketPubkey,
      baseDecimals,
      quoteDecimals,
    );

    const marketDesc = {
      name: `${symbol}-PERP`,
      publicKey: perpMarketPubkey,
      baseSymbol: symbol,
      baseDecimals,
      quoteDecimals,
      marketIndex,
      bidsKey: market.bids,
      asksKey: market.asks,
      eventsKey: market.eventQueue,
    };

    const marketConfig = getPerpMarketByBaseSymbol(groupConfig, symbol);
    if (marketConfig) {
      Object.assign(marketConfig, marketDesc);
    } else {
      groupConfig.perpMarkets.push(marketDesc);
    }

    config.storeGroup(groupConfig);
    writeConfig(config);
    console.log(`${symbol}/${groupConfig.quoteSymbol} perp market added`);
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

  const config = readConfig();
  const groupConfig = config.groups[0];
  const perpMarketPubkeys = groupConfig.perpMarkets.map(mkt => mkt.publicKey);

  await Promise.all([
    client.cachePrices(mangoGroup.publicKey, mangoCache.publicKey, mangoGroup.oracles, TEST_PAYER as unknown as Account),
    client.cachePerpMarkets(mangoGroup.publicKey, mangoCache.publicKey, perpMarketPubkeys, TEST_PAYER as unknown as Account)
  ]);
}
