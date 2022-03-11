import * as anchor from "@project-serum/anchor";
import { Program, Provider, Wallet } from "@project-serum/anchor";
import {
  Account,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  SingleConnectionBroadcaster,
  SolanaAugmentedProvider,
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
  SERUM_PROG_ID,
  setOraclePrice,
} from "./setupMango";
import {
  Config,
  createAccountInstruction,
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

  let OTHER_PROVIDER: SolanaAugmentedProvider;
  let OTHER_PAYER: Account;

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
  let providerQuoteATA: PublicKey;
  let providerIouATA: PublicKey;

  let otherAATA: PublicKey;
  let otherQuoteATA: PublicKey;
  let otherIouATA: PublicKey;

  // how many quote native tokens for 1 base native token
  let initialAPrice = 1;
  // let initialBPrice = 0.5;

  let marketA: MarketInfo;
  let marketB: MarketInfo;

  let mangoGroupPubkey: PublicKey;
  let client: MangoClient;

  before(async () => {
    OTHER_PAYER = new Account();
    OTHER_PROVIDER = new SolanaAugmentedProvider(
      new SolanaProvider(
        TEST_PROVIDER.connection,
        new SingleConnectionBroadcaster(TEST_PROVIDER.connection),
        new NodeWallet(OTHER_PAYER)
      )
    );
    const tx = await OTHER_PROVIDER.requestAirdrop(5 * LAMPORTS_PER_SOL)
    const txid = await tx.awaitSignatureConfirmation();
    
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
    // await setOraclePrice(client, "BBBB", initialBPrice);

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
      TEST_PROVIDER, 
      quoteToken.publicKey,
      5000000
    );
    providerAATA = await initializeProviderATA(TEST_PROVIDER, tokenA.publicKey, 5000000);
    // providerBATA = await initializeProviderATA(TEST_PROVIDER, tokenB.publicKey, 5000000);

    otherQuoteATA = await initializeProviderATA(
      OTHER_PROVIDER, 
      quoteToken.publicKey,
      5000000
    );
    otherAATA = await initializeProviderATA(OTHER_PROVIDER, tokenA.publicKey, 5000000);
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
    providerIouATA = await initializeProviderATA(TEST_PROVIDER, poolIouAddress, 0, false);

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

  it("will fail if a user tries to buy into the pool using a non-quote token", async () => {
    const depositAQuantity = new anchor.BN(1000000);
    //check provider IOU amount
    await checkProviderTokenAmount(providerIouATA, new anchor.BN(1500000));

    const group = await client.getMangoGroup(mangoGroupPubkey);
    const rootBanks = await group.loadRootBanks(TEST_PROVIDER.connection);
    const tokenIndex = group.getTokenIndex(tokenA.publicKey);
    const nodeBanks = await rootBanks[tokenIndex]?.loadNodeBanks(
      TEST_PROVIDER.connection
    );
    const mangoCache = await group.loadCache(TEST_PROVIDER.connection);
    if (!nodeBanks) {
      throw Error;
    }

    await keeperRefresh(client, group, mangoCache, rootBanks);

    const mangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      SERUM_PROG_ID
    );
    const openOrdersKeys = mangoAccount.getOpenOrdersKeysInBasket();
    const remainingAccounts = openOrdersKeys.map((key) => {
      return { pubkey: key, isWritable: false, isSigner: false };
    });

    await assert.rejects(
      async () => {
        const txn = await program.rpc.buyIntoPool(
          depositAQuantity,
          {
            accounts: {
              mangoProgram: MANGO_PROG_ID,
              pool: poolAddress,
              mangoGroup: mangoGroupPubkey,
              mangoAccount: mangoAccountAddress,
              depositor: TEST_PROVIDER.wallet.publicKey,
              depositorQuoteTokenAccount: providerAATA,
              mangoCache: mangoCache.publicKey,
              rootBank: rootBanks[tokenIndex]?.publicKey,
              nodeBank: nodeBanks[0].publicKey,
              vault: nodeBanks[0].vault,
              poolIouMint: poolIouAddress,
              depositorIouTokenAccount: providerIouATA,
              tokenProgram: TOKEN_PROGRAM_ID,
            },
            remainingAccounts,
            signers: [TEST_PAYER],
          }
        );
      },
      (err) => {
        console.log(err.logs);
        assert.ok(err.logs.includes("Program log: Custom program error: 0x8")); // Mango Invalid Token error
        return true;
      }
    );
  });

  it("will fail if user tries to withdraw a non-QUOTE token", async () => {
    const withdrawQuoteQuantity = new anchor.BN(500000);

    const group = await client.getMangoGroup(mangoGroupPubkey);
    const rootBanks = await group.loadRootBanks(TEST_PROVIDER.connection);
    const tokenIndex = group.getTokenIndex(tokenA.publicKey);
    const nodeBanks = await rootBanks[tokenIndex]?.loadNodeBanks(
      TEST_PROVIDER.connection
    );
    const mangoCache = await group.loadCache(TEST_PROVIDER.connection);
    if (!nodeBanks) {
      throw Error;
    }

    await keeperRefresh(client, group, mangoCache, rootBanks);

    const mangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      SERUM_PROG_ID
    );
    const openOrdersKeys = mangoAccount.getOpenOrdersKeysInBasket();
    const remainingAccounts = openOrdersKeys.map((key) => {
      return { pubkey: key, isWritable: false, isSigner: false };
    });

    await assert.rejects(
      async () => {
        const txn = await program.rpc.withdrawFromPool(withdrawQuoteQuantity, {
          accounts: {
            mangoProgram: MANGO_PROG_ID,
            pool: poolAddress,
            mangoGroup: mangoGroupPubkey,
            mangoGroupSigner: group.signerKey,
            mangoAccount: mangoAccountAddress,
            withdrawer: TEST_PROVIDER.wallet.publicKey,
            withdrawerTokenAccount: providerAATA,
            mangoCache: mangoCache.publicKey,
            rootBank: rootBanks[tokenIndex]?.publicKey,
            nodeBank: nodeBanks[0].publicKey,
            vault: nodeBanks[0].vault,
            poolIouMint: poolIouAddress,
            withdrawerIouTokenAccount: providerIouATA,
            tokenProgram: TOKEN_PROGRAM_ID,
          },
          remainingAccounts,
          signers: [TEST_PAYER],
        });
      },
      (err) => {
        console.log(err.logs);
        assert.ok(err.logs.includes("Program log: Custom program error: 0x8")); // Mango Invalid Token error
        return true;
      }
    );
  });

  it("will fail if user tries to withdraw too much", async () => {
    const withdrawQuoteQuantity = new anchor.BN(1500001);
    await checkProviderTokenAmount(providerIouATA, withdrawQuoteQuantity.sub(new anchor.BN(1)));

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

    const mangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      SERUM_PROG_ID
    );
    const openOrdersKeys = mangoAccount.getOpenOrdersKeysInBasket();
    const remainingAccounts = openOrdersKeys.map((key) => {
      return { pubkey: key, isWritable: false, isSigner: false };
    });

    await assert.rejects(
      async () => {
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
      },
      (err) => {
        console.log(err.logs);
        assert.ok(err.logs.includes("Program log: Custom program error: 0x7")); // Mango Insufficient Funds error
        return true;
      }
    );
  });

  it("allows delegate to trade on serum normally", async () => {
    const market = await Market.load(TEST_PROVIDER.connection, marketA.market, {}, SERUM_PROG_ID);
    const owner = new Account(TEST_PAYER.secretKey)

    const group = await client.getMangoGroup(mangoGroupPubkey);
    const rootBanks = await group.loadRootBanks(TEST_PROVIDER.connection);
    const mangoCache = await group.loadCache(TEST_PROVIDER.connection);
    const tokenIndex = group.getTokenIndex(tokenA.publicKey);

    await keeperRefresh(client, group, mangoCache, rootBanks);

    // mangoAccount places order
    const mangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      SERUM_PROG_ID
    );
    await client.placeSpotOrder2(group, mangoAccount, market, owner, "buy", 1, 1, "limit", new anchor.BN(1234), false);

    // someone else places a matching order via serum
    await market.placeOrder(OTHER_PROVIDER.connection, {
      owner: new Account(OTHER_PAYER.secretKey),
      payer: otherAATA,
      side: "sell",
      price: 1,
      size: 1,
      feeDiscountPubkey: null,
    });
  
    // crank the serum dex (match orders)
    const events = await market.loadEventQueue(TEST_PROVIDER.connection);
    const openOrdersPubkeys = events.map((e) => e.openOrders);
    await consumeEvents(TEST_PROVIDER, market, openOrdersPubkeys);
  
    // Mango settle funds
    await client.settleFunds(group, mangoAccount, owner, market);

    // check mangoAccount QUOTE amount
    await checkMangoAccountTokenAmount(mangoAccountAddress, QUOTE_INDEX, 0.5);
    // check mangoAccount AAAA amount
    await checkMangoAccountTokenAmount(mangoAccountAddress, tokenIndex, 1);  
});

  it("will mint proper amount of ious if another user deposits", async () => {
    const depositQuoteQuantity = new anchor.BN(1500000);
    otherIouATA = await initializeProviderATA(OTHER_PROVIDER as unknown as SolanaProvider, poolIouAddress, 0, false);

    // check IOU mint supply
    await checkIouMintSupply(poolIouAddress, new anchor.BN(1500000));
    //check depositor IOU amount
    await checkProviderTokenAmount(otherQuoteATA, new anchor.BN(5000000));
    await checkProviderTokenAmount(otherIouATA, ZERO_BN);

    const group = await client.getMangoGroup(mangoGroupPubkey);
    const rootBanks = await group.loadRootBanks(TEST_PROVIDER.connection);
    const nodeBanks = await rootBanks[QUOTE_INDEX]?.loadNodeBanks(
      TEST_PROVIDER.connection
    );
    const mangoCache = await group.loadCache(TEST_PROVIDER.connection);
    const tokenIndex = group.getTokenIndex(tokenA.publicKey);

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
        depositor: OTHER_PROVIDER.wallet.publicKey,
        depositorQuoteTokenAccount: otherQuoteATA,
        mangoCache: mangoCache.publicKey,
        rootBank: rootBanks[QUOTE_INDEX]?.publicKey,
        nodeBank: nodeBanks[0].publicKey,
        vault: nodeBanks[0].vault,
        poolIouMint: poolIouAddress,
        depositorIouTokenAccount: otherIouATA,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      remainingAccounts,
      signers: [OTHER_PAYER],
    });

    // check provider QUOTE amount
    await checkProviderTokenAmount(otherQuoteATA, new anchor.BN(3500000));
    // check mangoAccount amounts
    await checkMangoAccountTokenAmount(mangoAccountAddress, QUOTE_INDEX, 2);
    await checkMangoAccountTokenAmount(mangoAccountAddress, tokenIndex, 1);
    // check IOU mint supply
    await checkIouMintSupply(poolIouAddress, new anchor.BN(3000000));
    //check provider IOU amount
    await checkProviderTokenAmount(otherIouATA, depositQuoteQuantity);
  });


  it("withdrawal will take into account open orders and oracle price when valuing pool worth", async () => {
    // check IOU amounts, each user has deposited 1.5 QUOTE
    await checkIouMintSupply(poolIouAddress, new anchor.BN(3000000));
    await checkProviderTokenAmount(providerIouATA, new anchor.BN(1500000));
    await checkProviderTokenAmount(otherIouATA, new anchor.BN(1500000));

    // AAAA depreciates relative to QUOTE
    await setOraclePrice(client, "AAAA", 0.5);

    // mango account trades AAAA back to QUOTE
    const market = await Market.load(TEST_PROVIDER.connection, marketA.market, {}, SERUM_PROG_ID);
    const owner = new Account(TEST_PAYER.secretKey) 
    const group = await client.getMangoGroup(mangoGroupPubkey);
    const rootBanks = await group.loadRootBanks(TEST_PROVIDER.connection);
    const nodeBanks = await rootBanks[QUOTE_INDEX]?.loadNodeBanks(
      TEST_PROVIDER.connection
    );
    const mangoCache = await group.loadCache(TEST_PROVIDER.connection);
    const tokenIndex = group.getTokenIndex(tokenA.publicKey);

    await keeperRefresh(client, group, mangoCache, rootBanks);

    // mangoAccount places order at new deflated price
    const mangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      SERUM_PROG_ID
    );
    await client.placeSpotOrder2(group, mangoAccount, market, owner, "sell", 0.5, 1, "limit", new anchor.BN(4321), false);


    // user 1 decides to withdraw, but max withdraw is less than they started with (total worth of mangoAccount is 2.5 now)
    const openOrdersKeys = mangoAccount.getOpenOrdersKeysInBasket();
    const remainingAccounts = openOrdersKeys.map((key) => {
      return { pubkey: key, isWritable: false, isSigner: false };
    });
    const txn = await program.rpc.withdrawFromPool(new anchor.BN(1250000), {
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
    console.log('check provider QUOTE amount')
    await checkProviderTokenAmount(providerQuoteATA, new anchor.BN(4750000));
    // check mangoAccount QUOTE amount
    console.log('check mangoAccount QUOTE amount')
    await checkMangoAccountTokenAmount(mangoAccountAddress, QUOTE_INDEX, 0.75);
    // check IOU mint supply
    console.log('check IOU mint supply')
    await checkIouMintSupply(poolIouAddress, new anchor.BN(1500000));
    // check provider IOU amount
    console.log('check provider IOU amount')
    await checkProviderTokenAmount(providerIouATA, ZERO_BN);

  });

  // it("will prevent withdraw if too leveraged (perp order)", async () => {
  // });

  // it("will allow users to withdraw up to max leverage??? (spot)", async () => {
  // });

});
