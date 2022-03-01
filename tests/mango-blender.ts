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
  addSpotMarket,
  createMangoGroup,
  createToken,
  initializeProviderATA,
  initPriceOracles,
  keeperRefresh,
  MANGO_PROG_ID,
  setOraclePrice,
} from "./setupMango";
import {
  Config,
  MangoClient,
  uiToNative,
  ZERO_BN,
} from "@blockworks-foundation/mango-client";
import { MintLayout, Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getOrCreateATA, getTokenAccount, TokenAccountLayout } from "@saberhq/token-utils";
import { setupSpotMarket } from "./setupSerum";
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

  let providerAATA: PublicKey;
  let providerBATA: PublicKey;
  let providerQuoteATA: PublicKey;
  let providerIouATA: PublicKey;

  // how many quote native tokens for 1 base native token
  let initialAPrice = 10;
  let initialBPrice = 0.5;

  let totalQuoteNativeDeposited = new anchor.BN(0);

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
      [poolNameBytes, TEST_PROVIDER.wallet.publicKey.toBytes(), utf8.encode("iou")],
      program.programId
    );

    client = new MangoClient(TEST_PROVIDER.connection, MANGO_PROG_ID);

    // Create tokens (with same decimals for simplicity)
    quoteToken = await createToken(6);
    tokenA = await createToken(6);
    tokenB = await createToken(6);

    mangoGroupPubkey = await createMangoGroup(quoteToken);

    // add oracles
    await initPriceOracles(client, mangoGroupPubkey);

    // set oracle prices -> QUOTE is always 1
    // For a stub oracle the price we pass in is interpreted as how many quote native tokens for 1 base native token
    await setOraclePrice(client, "AAAA", initialAPrice);
    await setOraclePrice(client, "BBBB", initialBPrice);

    //create Serum markets
    const marketA = await setupSpotMarket(
      tokenA.publicKey,
      quoteToken.publicKey,
      1,
      1
    );
    const marketB = await setupSpotMarket(
      tokenB.publicKey,
      quoteToken.publicKey,
      1,
      1
    );

    //add Serum markets to Mango so we can deposit tokens
    await addSpotMarket(client, "AAAA", marketA.market, tokenA.publicKey);
    await addSpotMarket(client, "BBBB", marketB.market, tokenB.publicKey);

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
    providerQuoteATA = await initializeProviderATA(quoteToken.publicKey, 5000000);
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
          depositIouMint: poolIouAddress,
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
    const poolIouMintAccountInfo = await TEST_PROVIDER.connection.getAccountInfo(
      poolIouAddress
    );
    const poolIouMint = MintLayout.decode(poolIouMintAccountInfo.data);
    assert.ok(poolIouMintAccountInfo.owner.equals(TOKEN_PROGRAM_ID));
    assert.ok(poolAddress.equals(new PublicKey(poolIouMint.freezeAuthority)));
    assert.ok(poolAddress.equals(new PublicKey(poolIouMint.mintAuthority)));

    //check mangoAccount has been initialized with correct delegate
    const mangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      MANGO_PROG_ID
    );
    assert.ok(mangoAccount.metaData.isInitialized);
    assert.ok(mangoAccount.delegate.equals(TEST_PROVIDER.wallet.publicKey));
  });

  it("allows a user to deposit QUOTE into the delegated mangoAccount", async () => {
    const beforeWalletQuoteQuantity = new anchor.BN(5000000);
    const depositQuoteQuantity = new anchor.BN(1000000);
    const providerQuoteBefore = await getTokenAccount(TEST_PROVIDER, providerQuoteATA);
    assert.ok(providerQuoteBefore.amount.eq(beforeWalletQuoteQuantity));

    providerIouATA = await initializeProviderATA(poolIouAddress, 0, false);
    const providerIouBefore = await getTokenAccount(TEST_PROVIDER, providerIouATA);
    assert.ok(providerIouBefore.amount.eq(ZERO_BN));

    const group = await client.getMangoGroup(mangoGroupPubkey);
    const rootBanks = await group.loadRootBanks(TEST_PROVIDER.connection);
    const tokenIndex = group.getTokenIndex(quoteToken.publicKey);
    const nodeBanks = await rootBanks[tokenIndex]?.loadNodeBanks(
      TEST_PROVIDER.connection
    );
    const mangoCache = await group.loadCache(TEST_PROVIDER.connection);
    if (!nodeBanks) {
      throw Error;
    }

    await keeperRefresh(client, group, mangoCache, rootBanks);

    const beforeMangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      MANGO_PROG_ID
    );
    const openOrdersKeys = beforeMangoAccount.getOpenOrdersKeysInBasket();
    const remainingAccounts = openOrdersKeys.map((key) =>  {return { pubkey: key, isWritable: false, isSigner: false } })

    const tx = await program.rpc.deposit(depositQuoteQuantity, tokenIndex, {
      accounts: {
        mangoProgram: MANGO_PROG_ID,
        pool: poolAddress,
        mangoGroup: mangoGroupPubkey,
        mangoAccount: mangoAccountAddress,
        depositor: TEST_PROVIDER.wallet.publicKey,
        depositorTokenAccount: providerQuoteATA,
        mangoCache: mangoCache.publicKey,
        rootBank: rootBanks[tokenIndex]?.publicKey,
        nodeBank: nodeBanks[0].publicKey,
        vault: nodeBanks[0].vault,
        depositIouMint: poolIouAddress,
        depositorIouTokenAccount: providerIouATA,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      remainingAccounts,
      signers: [TEST_PAYER],
    });

    //check quoteToken subtracted from depositor
    const providerQuoteAfter = await getTokenAccount(TEST_PROVIDER, providerQuoteATA);
    assert.ok(
      providerQuoteAfter.amount.eq(beforeWalletQuoteQuantity.sub(depositQuoteQuantity))
    );

    //check quoteToken in mangoAccount
    const mangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      MANGO_PROG_ID
    );
    assert.ok(mangoAccount.deposits[tokenIndex].toNumber() === 1);

    // check IOU mint supply
    const iouMintInfo = await getMintInfo(TEST_PROVIDER, poolIouAddress);
    assert.ok(iouMintInfo.supply.eq(depositQuoteQuantity));

    // check depositor IOU amount
    const providerIouAfter = await getTokenAccount(TEST_PROVIDER, providerIouATA);
    assert.ok(
      providerIouAfter.amount.eq(iouMintInfo.supply)
    );
    totalQuoteNativeDeposited = totalQuoteNativeDeposited.add(depositQuoteQuantity)
  });

  it("allows a user to deposit TOKEN_A into the delegated mangoAccount", async () => {
    const beforeWalletAQuantity = new anchor.BN(5000000);
    const depositAQuantity = new anchor.BN(1000000);
    const providerABefore = await getTokenAccount(TEST_PROVIDER, providerAATA);
    assert.ok(providerABefore.amount.eq(beforeWalletAQuantity));

    providerIouATA = await initializeProviderATA(poolIouAddress, 0, false);
    const providerIouBefore = await getTokenAccount(TEST_PROVIDER, providerIouATA);
    assert.ok(providerIouBefore.amount.eq(new anchor.BN(1000000)));

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

    const beforeMangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      MANGO_PROG_ID
    );
    const openOrdersKeys = beforeMangoAccount.getOpenOrdersKeysInBasket();
    const remainingAccounts = openOrdersKeys.map((key) =>  {return { pubkey: key, isWritable: false, isSigner: false } })

    const tx = await program.rpc.deposit(depositAQuantity, tokenIndex, {
      accounts: {
        mangoProgram: MANGO_PROG_ID,
        pool: poolAddress,
        mangoGroup: mangoGroupPubkey,
        mangoAccount: mangoAccountAddress,
        depositor: TEST_PROVIDER.wallet.publicKey,
        depositorTokenAccount: providerAATA,
        mangoCache: mangoCache.publicKey,
        rootBank: rootBanks[tokenIndex]?.publicKey,
        nodeBank: nodeBanks[0].publicKey,
        vault: nodeBanks[0].vault,
        depositIouMint: poolIouAddress,
        depositorIouTokenAccount: providerIouATA,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      remainingAccounts,
      signers: [TEST_PAYER],
    });

    //check tokenA subtracted from depositor
    const providerAAfter = await getTokenAccount(TEST_PROVIDER, providerAATA);
    assert.ok(
      providerAAfter.amount.eq(beforeWalletAQuantity.sub(depositAQuantity))
    );

    //check tokenA in mangoAccount
    const mangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      MANGO_PROG_ID
    );
    assert.ok(mangoAccount.deposits[tokenIndex].toNumber() === 1);

    // check IOU mint supply
    const iouMintInfo = await getMintInfo(TEST_PROVIDER, poolIouAddress);
    const totalIouSupply = depositAQuantity.mul(new anchor.BN(initialAPrice)).add(totalQuoteNativeDeposited) // (amount A deposited * price) + quote amount deposited prior
    assert.ok(iouMintInfo.supply.eq(totalIouSupply));

    // check depositor IOU amount
    const providerIouAfter = await getTokenAccount(TEST_PROVIDER, providerIouATA);
    assert.ok(
      providerIouAfter.amount.eq(totalIouSupply)
    );
    totalQuoteNativeDeposited = totalQuoteNativeDeposited.add(depositAQuantity.mul(new anchor.BN(initialAPrice)));
  });
});
