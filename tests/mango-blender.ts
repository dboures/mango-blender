import * as anchor from "@project-serum/anchor";
import { Program, Provider } from "@project-serum/anchor";
import {
  Account,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  SingleConnectionBroadcaster,
  SolanaProvider,
} from "@saberhq/solana-contrib";
import { getMintInfo, NodeWallet } from "@project-serum/common";
import { MangoBlender } from "../target/types/mango_blender";
import {
  addPerpMarket,
  addSpotMarket,
  createMangoGroup,
  createToken,
  initializeProviderATA,
  initPriceOracles,
  keeperRefresh,
  MANGO_PROG_ID,
  placeSpotOrder,
  SERUM_PROG_ID,
  setOraclePrice,
} from "./setupMango";
import {
  Config,
  getAllMarkets,
  MangoClient,
  QUOTE_INDEX,
  uiToNative,
  ZERO_BN,
} from "@blockworks-foundation/mango-client";
import { MintLayout, Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  getOrCreateATA,
  getTokenAccount,
  TokenAccountLayout,
} from "@saberhq/token-utils";
import { consumeEvents, MarketInfo, setupSpotMarket } from "./setupSerum";
import { Market } from "@project-serum/serum/lib/market";
import { checkIouMintSupply, checkMangoAccountTokenAmount, checkProviderTokenAmount } from "./assertions";
const assert = require("assert");
const utf8 = anchor.utils.bytes.utf8;

const baseProvider = Provider.local();
export const TEST_PROVIDER = new SolanaProvider(
  baseProvider.connection,
  new SingleConnectionBroadcaster(baseProvider.connection),
  baseProvider.wallet
);
export const TEST_PAYER = Keypair.fromSecretKey(
  (baseProvider.wallet as NodeWallet).payer.secretKey
);

describe("mango-blender", () => {
  let program: any;

  let poolAddress: PublicKey;
  let poolBump: number;
  let poolIouAddress: PublicKey;
  let poolIouBump: number;
  let poolName: string;
  let poolNameBytes: Uint8Array;

  let mangoAccountAddress: PublicKey;
  let mangoAccountBump: number;

  let tokenA: Token;
  let tokenB: Token;
  let quoteToken: Token;
  let dummyMngoToken: Token;

  let providerAATA: PublicKey;
  let providerBATA: PublicKey;
  let providerQuoteATA: PublicKey;
  let providerIouATA: PublicKey;

  // how many quote native tokens for 1 base native token
  let initialAPrice = 10;
  let initialBPrice = 0.5;

  let totalQuoteNativeDeposited = new anchor.BN(0);

  let marketA: MarketInfo;
  let marketB: MarketInfo;

  let mangoGroupPubkey: PublicKey;
  let client: MangoClient;

  before(async () => {
    program = anchor.workspace.MangoBlender as Program<MangoBlender>;
    poolName = "testpool";
    poolNameBytes = utf8.encode(poolName);

    [poolAddress, poolBump] = await PublicKey.findProgramAddress(
      [poolNameBytes, TEST_PROVIDER.wallet.publicKey.toBytes()],
      program.programId
    );

    [poolIouAddress, poolIouBump] = await PublicKey.findProgramAddress(
      [
        poolNameBytes,
        TEST_PROVIDER.wallet.publicKey.toBytes(),
        utf8.encode("iou"),
      ],
      program.programId
    );

    client = new MangoClient(TEST_PROVIDER.connection, MANGO_PROG_ID);

    // Create tokens (with same decimals for simplicity)
    quoteToken = await createToken(6);
    tokenA = await createToken(6);
    tokenB = await createToken(6);
    dummyMngoToken = await createToken(6);

    mangoGroupPubkey = await createMangoGroup(quoteToken);

    // add oracles
    await initPriceOracles(client, mangoGroupPubkey);

    // set oracle prices -> QUOTE is always 1
    // For a stub oracle the price we pass in is interpreted as how many quote native tokens for 1 base native token
    await setOraclePrice(client, "AAAA", initialAPrice);
    await setOraclePrice(client, "BBBB", initialBPrice);

    //create Serum markets
    marketA = await setupSpotMarket(
      tokenA.publicKey,
      quoteToken.publicKey,
      1,
      1
    );
    marketB = await setupSpotMarket(
      tokenB.publicKey,
      quoteToken.publicKey,
      1,
      1
    );

    //add Serum markets to Mango so we can deposit tokens
    await addSpotMarket(client, "AAAA", marketA.market, tokenA.publicKey);
    await addSpotMarket(client, "BBBB", marketB.market, tokenB.publicKey);

    await addPerpMarket(client, "AAAA", dummyMngoToken.publicKey);

    [mangoAccountAddress, mangoAccountBump] =
      await PublicKey.findProgramAddress(
        [
          mangoGroupPubkey.toBytes(),
          poolAddress.toBytes(),
          new anchor.BN(1).toArrayLike(Buffer, "le", 8), // account_num
        ],
        MANGO_PROG_ID
      );

    // 5 tokens each
    providerQuoteATA = await initializeProviderATA(
      quoteToken.publicKey,
      5000000
    );
    providerAATA = await initializeProviderATA(tokenA.publicKey, 5000000);
    providerBATA = await initializeProviderATA(tokenB.publicKey, 5000000);
  });

  it("can create a liquidator pool, which includes a delegated mangoAccount for liqor", async () => {
    const accountNum = new anchor.BN(1);
    const tx = await program.rpc.createPool(
      poolNameBytes,
      poolBump,
      poolIouBump,
      accountNum,
      {
        accounts: {
          pool: poolAddress,
          poolIouMint: poolIouAddress,
          admin: TEST_PROVIDER.wallet.publicKey,
          mangoProgram: MANGO_PROG_ID,
          mangoGroup: mangoGroupPubkey,
          mangoAccount: mangoAccountAddress,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        },
        signers: [TEST_PAYER],
      }
    );

    // check pool has been initialized correctly
    const initializedPool = await program.account.pool.fetch(poolAddress);
    assert.ok(
      initializedPool.admin.toBase58() ===
        TEST_PROVIDER.wallet.publicKey.toBase58()
    );
    assert.ok(initializedPool.iouMint.toBase58() === poolIouAddress.toBase58());
    assert.ok(initializedPool.poolName === poolName);

    // check iou mint has been initialized correctly
    const poolIouMintAccountInfo =
      await TEST_PROVIDER.connection.getAccountInfo(poolIouAddress);
    const poolIouMint = MintLayout.decode(poolIouMintAccountInfo.data);
    assert.ok(poolIouMintAccountInfo.owner.equals(TOKEN_PROGRAM_ID));
    assert.ok(poolAddress.equals(new PublicKey(poolIouMint.freezeAuthority)));
    assert.ok(poolAddress.equals(new PublicKey(poolIouMint.mintAuthority)));

    //check mangoAccount has been initialized with correct delegate
    const mangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      SERUM_PROG_ID
    );
    assert.ok(mangoAccount.metaData.isInitialized);
    assert.ok(mangoAccount.delegate.equals(TEST_PROVIDER.wallet.publicKey));
  });

  it("allows a user to buy into the pool by depositing QUOTE into the delegated mangoAccount", async () => {
    const depositQuoteQuantity = new anchor.BN(2000000);
    providerIouATA = await initializeProviderATA(poolIouAddress, 0, false);

    // check IOU mint supply
    await checkIouMintSupply(poolIouAddress, ZERO_BN);
    //check depositor IOU amount
    await checkProviderTokenAmount(providerQuoteATA, new anchor.BN(5000000));

    const group = await client.getMangoGroup(mangoGroupPubkey);
    const rootBanks = await group.loadRootBanks(TEST_PROVIDER.connection);
    const nodeBanks = await rootBanks[QUOTE_INDEX]?.loadNodeBanks(
      TEST_PROVIDER.connection
    );
    const mangoCache = await group.loadCache(TEST_PROVIDER.connection);
    if (!nodeBanks) {
      throw Error;
    }

    await keeperRefresh(client, group, mangoCache, rootBanks);

    const beforeMangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      SERUM_PROG_ID
    );
    const openOrdersKeys = beforeMangoAccount.getOpenOrdersKeysInBasket();
    const remainingAccounts = openOrdersKeys.map((key) => {
      return { pubkey: key, isWritable: false, isSigner: false };
    });

    const tx = await program.rpc.buyIntoPool(depositQuoteQuantity, {
      accounts: {
        mangoProgram: MANGO_PROG_ID,
        pool: poolAddress,
        mangoGroup: mangoGroupPubkey,
        mangoAccount: mangoAccountAddress,
        depositor: TEST_PROVIDER.wallet.publicKey,
        depositorQuoteTokenAccount: providerQuoteATA,
        mangoCache: mangoCache.publicKey,
        rootBank: rootBanks[QUOTE_INDEX]?.publicKey,
        nodeBank: nodeBanks[0].publicKey,
        vault: nodeBanks[0].vault,
        poolIouMint: poolIouAddress,
        depositorIouTokenAccount: providerIouATA,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      remainingAccounts,
      signers: [TEST_PAYER],
    });
    // check provider QUOTE amount
    await checkProviderTokenAmount(providerQuoteATA, new anchor.BN(3000000));
    // check mangoAccount QUOTE amount
    await checkMangoAccountTokenAmount(mangoAccountAddress, QUOTE_INDEX, 2);
    // check IOU mint supply
    await checkIouMintSupply(poolIouAddress, depositQuoteQuantity);
    //check provider IOU amount
    await checkProviderTokenAmount(providerIouATA, depositQuoteQuantity);
  });

  it("will allow a user to withdraw QUOTE", async () => {
    const withdrawQuoteQuantity = new anchor.BN(500000);
    // check provider QUOTE amount
    await checkProviderTokenAmount(providerQuoteATA, new anchor.BN(3000000));
    //check provider IOU amount
    await checkProviderTokenAmount(providerIouATA, new anchor.BN(2000000));

    const group = await client.getMangoGroup(mangoGroupPubkey);
    const rootBanks = await group.loadRootBanks(TEST_PROVIDER.connection);
    const nodeBanks = await rootBanks[QUOTE_INDEX]?.loadNodeBanks(
      TEST_PROVIDER.connection
    );
    const mangoCache = await group.loadCache(TEST_PROVIDER.connection);
    if (!nodeBanks) {
      throw Error;
    }

    await keeperRefresh(client, group, mangoCache, rootBanks);

    // check mangoAccount QUOTE amount
    await checkMangoAccountTokenAmount(mangoAccountAddress, QUOTE_INDEX, 2);
    const beforeMangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      SERUM_PROG_ID
    );
    const openOrdersKeys = beforeMangoAccount.getOpenOrdersKeysInBasket();
    const remainingAccounts = openOrdersKeys.map((key) => {
      return { pubkey: key, isWritable: false, isSigner: false };
    });

    const txn = await program.rpc.withdrawFromPool(withdrawQuoteQuantity, {
      accounts: {
        mangoProgram: MANGO_PROG_ID,
        pool: poolAddress,
        mangoGroup: mangoGroupPubkey,
        mangoGroupSigner: group.signerKey,
        mangoAccount: mangoAccountAddress,
        withdrawer: TEST_PROVIDER.wallet.publicKey,
        withdrawerTokenAccount: providerQuoteATA,
        mangoCache: mangoCache.publicKey,
        rootBank: rootBanks[QUOTE_INDEX]?.publicKey,
        nodeBank: nodeBanks[0].publicKey,
        vault: nodeBanks[0].vault,
        poolIouMint: poolIouAddress,
        withdrawerIouTokenAccount: providerIouATA,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      remainingAccounts,
      signers: [TEST_PAYER],
    });

    // check provider QUOTE amount
    await checkProviderTokenAmount(providerQuoteATA, new anchor.BN(3500000));
    // check mangoAccount QUOTE amount
    await checkMangoAccountTokenAmount(mangoAccountAddress, QUOTE_INDEX, 1.5);
    // check IOU mint supply
    await checkIouMintSupply(poolIouAddress, new anchor.BN(1500000));
    //check provider IOU amount
    await checkProviderTokenAmount(providerIouATA, new anchor.BN(1500000));
  });

  it("allows delegate to trade on serum normally", async () => {
      const market = await Market.load(TEST_PROVIDER.connection, marketA.market, {}, SERUM_PROG_ID);
      const owner = new Account(TEST_PAYER.secretKey)

      // "someone else" places an order via serum (owner used for simplicity)
      await market.placeOrder(TEST_PROVIDER.connection, {
        owner: new Account(TEST_PAYER.secretKey),
        payer: providerAATA,
        side: "sell",
        price: 1,
        size: 1,
        feeDiscountPubkey: null,
      });

      const group = await client.getMangoGroup(mangoGroupPubkey);
      const rootBanks = await group.loadRootBanks(TEST_PROVIDER.connection);
      const nodeBanks = await rootBanks[QUOTE_INDEX]?.loadNodeBanks(
        TEST_PROVIDER.connection
      );
      const mangoCache = await group.loadCache(TEST_PROVIDER.connection);
      if (!nodeBanks) {
        throw Error;
      }
  
      await keeperRefresh(client, group, mangoCache, rootBanks);

      const tokenIndex = group.getTokenIndex(tokenA.publicKey);
      // mangoAccount places matching order
      const mangoAccount = await client.getMangoAccount(
        mangoAccountAddress,
        SERUM_PROG_ID
      );
      await client.placeSpotOrder2(group, mangoAccount, market, owner, "buy", 1, 1, "limit", new anchor.BN(1234), false);
    
      // crank the serum dex (match orders)
      const events = await market.loadEventQueue(TEST_PROVIDER.connection);
      const openOrdersPubkeys = events.map((e) => e.openOrders);
      await consumeEvents(TEST_PROVIDER, market, openOrdersPubkeys);
    
      // Mango settle funds
      await client.settleFunds(group, mangoAccount, owner, market);

      // check mangoAccount QUOTE amount
      await checkMangoAccountTokenAmount(mangoAccountAddress, QUOTE_INDEX, 0.4996799999999979); // Serum fees
      // check mangoAccount AAAA amount
      await checkMangoAccountTokenAmount(mangoAccountAddress, tokenIndex, 1);
        
  });

    // // TODO: move this test to the end so that there are other tokens in MangoAccount (fails bc nodebank only has quote rn)
  // it("will fail if a user tries to buy into the pool using a non-quote token", async () => {
  //   const depositAQuantity = new anchor.BN(1000000);

  //   const providerIouBefore = await getTokenAccount(
  //     TEST_PROVIDER,
  //     providerIouATA
  //   );
  //   assert.ok(providerIouBefore.amount.eq(new anchor.BN(1000000)));

  //   const group = await client.getMangoGroup(mangoGroupPubkey);
  //   const rootBanks = await group.loadRootBanks(TEST_PROVIDER.connection);
  //   const tokenIndex = group.getTokenIndex(tokenA.publicKey);
  //   const nodeBanks = await rootBanks[QUOTE_INDEX]?.loadNodeBanks(
  //     TEST_PROVIDER.connection
  //   );
  //   const mangoCache = await group.loadCache(TEST_PROVIDER.connection);
  //   if (!nodeBanks) {
  //     throw Error;
  //   }

  //   await keeperRefresh(client, group, mangoCache, rootBanks);

  //   const mangoAccount = await client.getMangoAccount(
  //     mangoAccountAddress,
  //     SERUM_PROG_ID
  //   );
  //   const openOrdersKeys = mangoAccount.getOpenOrdersKeysInBasket();
  //   const remainingAccounts = openOrdersKeys.map((key) => {
  //     return { pubkey: key, isWritable: false, isSigner: false };
  //   });

  //   await assert.rejects(
  //     async () => {
  //       const txn = await program.rpc.buyIntoPool(
  //         depositAQuantity,
  //         {
  //           accounts: {
  //             mangoProgram: MANGO_PROG_ID,
  //             pool: poolAddress,
  //             mangoGroup: mangoGroupPubkey,
  //             mangoAccount: mangoAccountAddress,
  //             depositor: TEST_PROVIDER.wallet.publicKey,
  //             depositorQuoteTokenAccount: providerAATA,
  //             mangoCache: mangoCache.publicKey,
  //             rootBank: rootBanks[tokenIndex]?.publicKey,
  //             nodeBank: nodeBanks[0].publicKey,
  //             vault: nodeBanks[0].vault,
  //             poolIouMint: poolIouAddress,
  //             depositorIouTokenAccount: providerIouATA,
  //             tokenProgram: TOKEN_PROGRAM_ID,
  //           },
  //           remainingAccounts,
  //           signers: [TEST_PAYER],
  //         }
  //       );
  //     },
  //     (err) => {
  //       console.log(err.logs);
  //       assert.ok(err.logs.includes("Program log: Custom program error: 0x8")); // Mango Invalid Token error
  //       return true;
  //     }
  //   );
  // });

  // it("will fail if user tries to withdraw a non-QUOTE token", async () => {
  // });

  // it("will prevent withdraw if too leveraged (perp order)", async () => {
  // });

  // it("will allow users to withdraw up to max leverage??? (spot)", async () => {
  // });

  // it("withdrawer will 'lose money' if mangoAccount decreases in value", async () => {
  // });

});
