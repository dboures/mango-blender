import * as anchor from "@project-serum/anchor";
import { Program, Provider } from "@project-serum/anchor";
import {
  Account,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  SingleConnectionBroadcaster,
  SolanaProvider,
} from "@saberhq/solana-contrib";
import { NodeWallet } from "@project-serum/common";
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
import { Config, MangoClient, uiToNative } from "@blockworks-foundation/mango-client";
import { Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getTokenAccount } from "@saberhq/token-utils";
import { setupSpotMarket } from "./setupSerum";
const assert = require("assert");

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
  let poolName: string;
  let poolNameBytes: Buffer;

  let mangoAccountAddress: PublicKey;
  let mangoAccountBump: number;

  let tokenA: Token;
  let tokenB: Token;
  let quoteToken: Token;

  let providerAATA: PublicKey;
  let providerBATA: PublicKey;
  let providerQuoteATA: PublicKey;

  let mangoGroupPubkey: PublicKey;
  let client: MangoClient;

  before(async () => {
    program = anchor.workspace.MangoBlender as Program<MangoBlender>;
    poolName = "testpool";
    poolNameBytes = Buffer.from(poolName, "utf-8");

    [poolAddress, poolBump] = await PublicKey.findProgramAddress(
      [poolNameBytes, TEST_PROVIDER.wallet.publicKey.toBytes()],
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
    await setOraclePrice(client, 'AAAA', 10);
    await setOraclePrice(client, 'BBBB', 0.5);

    //create Serum markets
    const marketA = await setupSpotMarket(tokenA.publicKey, quoteToken.publicKey, 1, 1);
    const marketB = await setupSpotMarket(tokenB.publicKey, quoteToken.publicKey, 1, 1);

    //add Serum markets to Mango so we can deposit tokens
    await addSpotMarket(client, 'AAAA', marketA.market, tokenA.publicKey);
    await addSpotMarket(client, 'BBBB', marketB.market, tokenB.publicKey);

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
      quoteToken,
      5000000
    );
    providerAATA = await initializeProviderATA(
      tokenA,
      5000000
    );
    providerBATA = await initializeProviderATA(
      tokenB,
      5000000
    );
  });

  it("can create a liquidator pool, which includes a delegated mangoAccount for liqor", async () => {
    const accountNum = new anchor.BN(1);
    const tx = await program.rpc.createPool(
      poolNameBytes,
      poolBump,
      accountNum,
      {
        accounts: {
          pool: poolAddress,
          admin: TEST_PROVIDER.wallet.publicKey,
          mangoProgram: MANGO_PROG_ID,
          mangoGroup: mangoGroupPubkey,
          mangoAccount: mangoAccountAddress,
          systemProgram: SystemProgram.programId,
        },
        signers: [TEST_PAYER],
      }
    );

    const initializedPool = await program.account.pool.fetch(poolAddress);
    assert.ok(
      initializedPool.admin.toBase58() === TEST_PROVIDER.wallet.publicKey.toBase58()
    );

    const mangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      MANGO_PROG_ID
    );
    assert.ok(mangoAccount.metaData.isInitialized);
    assert.ok(mangoAccount.delegate.equals(TEST_PROVIDER.wallet.publicKey));
  });

  // it("allows a user to deposit QUOTE into the delegated mangoAccount", async () => {
  //   const providerQuoteBefore = await getTokenAccount(
  //     provider,
  //     providerQuoteATA
  //   );
  //   assert.ok(providerQuoteBefore.amount.eq(new anchor.BN(5000000)));

  //   const group = await client.getMangoGroup(mangoGroupPubkey);
  //   const rootBanks = await group.loadRootBanks(provider.connection);
  //   const rootBankPubkeys = rootBanks
  //     .map((rb) => rb?.publicKey)
  //     .filter((pk) => pk !== undefined) as PublicKey[];
  //   const tokenIndex = group.getTokenIndex(quoteToken.publicKey);
  //   const nodeBanks = await rootBanks[tokenIndex]?.loadNodeBanks(
  //     provider.connection
  //   );
  //   const mangoCache = await group.loadCache(provider.connection);
  //   if (!nodeBanks) {
  //     throw Error;
  //   }

  //   await client.cacheRootBanks(
  //     mangoGroupPubkey,
  //     mangoCache.publicKey,
  //     rootBankPubkeys,
  //     payer as unknown as Account
  //   );

  //   //await client.cachePrices

  //   const tx = await program.rpc.deposit(new anchor.BN(1000000), tokenIndex, {
  //     accounts: {
  //       mangoProgram: MANGO_PROG_ID,
  //       pool: poolAddress,
  //       mangoGroup: mangoGroupPubkey,
  //       mangoAccount: mangoAccountAddress,
  //       depositor: provider.wallet.publicKey,
  //       depositorTokenAccount: providerQuoteATA,
  //       mangoCache: mangoCache.publicKey,
  //       rootBank: rootBanks[tokenIndex]?.publicKey,
  //       nodeBank: nodeBanks[0].publicKey,
  //       vault: nodeBanks[0].vault,
  //       tokenProgram: TOKEN_PROGRAM_ID,
  //     },
  //     signers: [payer],
  //   });

  //   const providerQuoteAfter = await getTokenAccount(
  //     provider,
  //     providerQuoteATA
  //   );
  //   assert.ok(providerQuoteAfter.amount.eq(new anchor.BN(4000000)));

  //   const mangoAccount = await client.getMangoAccount(
  //     mangoAccountAddress,
  //     MANGO_PROG_ID
  //   );
  //   assert.ok(mangoAccount.deposits[tokenIndex].toNumber() === 1);

  //   const pool = await program.account.pool.fetch(poolAddress);
  //   console.log(pool.totalUsdcDeposits);
  //   assert.ok(pool.totalUsdcDeposits.toNumber() === 1000000);

  //   // TODO: assert that the wallet got the right amount of QUOTE
  // });

  it("allows a user to deposit TOKEN_A into the delegated mangoAccount", async () => {
    const beforeWalletQuantity = new anchor.BN(5000000);
    const depositQuantity = new anchor.BN(1000000);
    const providerABefore = await getTokenAccount(
      TEST_PROVIDER,
      providerAATA
    );
    assert.ok(providerABefore.amount.eq(beforeWalletQuantity));
  
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
  
    const tx = await program.rpc.deposit(depositQuantity, tokenIndex, {
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
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [TEST_PAYER],
    });
  
    const providerAAfter = await getTokenAccount(
      TEST_PROVIDER,
      providerAATA
    );
    assert.ok(providerAAfter.amount.eq(beforeWalletQuantity.sub(depositQuantity)));
  
    const mangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      MANGO_PROG_ID
    );
    assert.ok(mangoAccount.deposits[tokenIndex].toNumber() === 1);
  
    const pool = await program.account.pool.fetch(poolAddress);
    // console.log(pool.totalUsdcDeposits);
    // assert.ok(pool.totalUsdcDeposits.eq(depositQuantity));
  });


});


