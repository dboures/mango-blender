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
  createMangoGroup,
  createToken,
  initializeProviderATA,
  initPriceOracles,
  MANGO_PROG_ID,
} from "./setupMango";
import { Config, MangoClient } from "@blockworks-foundation/mango-client";
import { Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getTokenAccount } from "@saberhq/token-utils";
const assert = require("assert");


describe("mango-blender", () => {
  let program: any;
  let provider: SolanaProvider;
  let payer: Keypair;

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
    const baseProvider = Provider.local();
    provider = new SolanaProvider(
      baseProvider.connection,
      new SingleConnectionBroadcaster(baseProvider.connection),
      baseProvider.wallet
    );
    payer = Keypair.fromSecretKey(
      (baseProvider.wallet as NodeWallet).payer.secretKey
    );
    program = anchor.workspace.MangoBlender as Program<MangoBlender>;
    poolName = "testpool";
    poolNameBytes = Buffer.from(poolName, "utf-8");

    [poolAddress, poolBump] = await PublicKey.findProgramAddress(
      [poolNameBytes, provider.wallet.publicKey.toBytes()],
      program.programId
    );

    client = new MangoClient(provider.connection, MANGO_PROG_ID);

    quoteToken = await createToken(provider, payer, 6);
    tokenA = await createToken(provider, payer, 3);
    tokenB = await createToken(provider, payer, 9);
    mangoGroupPubkey = await createMangoGroup(provider, payer, quoteToken);

    // add oracles
    await initPriceOracles(payer, client, mangoGroupPubkey);

    // set oracle prices
    // await setOraclePrice('QUOTE', 1);
    // await setOraclePrice('AAAA', 0.1);
    // await setOraclePrice('BBBB', 2);

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
      provider,
      payer,
      quoteToken,
      5000000
    );
    providerAATA = await initializeProviderATA(
      provider,
      payer,
      tokenA,
      5000
    );
    providerBATA = await initializeProviderATA(
      provider,
      payer,
      tokenB,
      5000000000
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
          admin: provider.wallet.publicKey,
          mangoProgram: MANGO_PROG_ID,
          mangoGroup: mangoGroupPubkey,
          mangoAccount: mangoAccountAddress,
          systemProgram: SystemProgram.programId,
        },
        signers: [payer],
      }
    );

    const initializedPool = await program.account.pool.fetch(poolAddress);
    assert.ok(
      initializedPool.admin.toBase58() === provider.wallet.publicKey.toBase58()
    );

    const mangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      MANGO_PROG_ID
    );
    assert.ok(mangoAccount.metaData.isInitialized);
    assert.ok(mangoAccount.delegate.equals(provider.wallet.publicKey));
  });

  it("allows a user to deposit QUOTE into the delegated mangoAccount", async () => {
    const providerQuoteBefore = await getTokenAccount(
      provider,
      providerQuoteATA
    );
    assert.ok(providerQuoteBefore.amount.eq(new anchor.BN(5000000)));

    const group = await client.getMangoGroup(mangoGroupPubkey);
    const rootBanks = await group.loadRootBanks(provider.connection);
    const rootBankPubkeys = rootBanks
      .map((rb) => rb?.publicKey)
      .filter((pk) => pk !== undefined) as PublicKey[];
    const tokenIndex = group.getTokenIndex(quoteToken.publicKey);
    const nodeBanks = await rootBanks[tokenIndex]?.loadNodeBanks(
      provider.connection
    );
    const mangoCache = await group.loadCache(provider.connection);
    if (!nodeBanks) {
      throw Error;
    }

    await client.cacheRootBanks(
      mangoGroupPubkey,
      mangoCache.publicKey,
      rootBankPubkeys,
      payer as unknown as Account
    );

    //await client.cachePrices

    const tx = await program.rpc.deposit(new anchor.BN(1000000), 15, {
      accounts: {
        mangoProgram: MANGO_PROG_ID,
        pool: poolAddress,
        mangoGroup: mangoGroupPubkey,
        mangoAccount: mangoAccountAddress,
        depositor: provider.wallet.publicKey,
        depositorTokenAccount: providerQuoteATA,
        mangoCache: mangoCache.publicKey,
        rootBank: rootBanks[tokenIndex]?.publicKey,
        nodeBank: nodeBanks[0].publicKey,
        vault: nodeBanks[0].vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [payer],
    });

    const providerQuoteAfter = await getTokenAccount(
      provider,
      providerQuoteATA
    );
    assert.ok(providerQuoteAfter.amount.eq(new anchor.BN(4000000)));

    const mangoAccount = await client.getMangoAccount(
      mangoAccountAddress,
      MANGO_PROG_ID
    );
    assert.ok(mangoAccount.deposits[tokenIndex].toNumber() === 1);

    const pool = await program.account.pool.fetch(poolAddress);
    console.log(pool.totalUsdcDeposits);
    assert.ok(pool.totalUsdcDeposits.toNumber() === 1000000);
  });
});

// it("allows a user to deposit TOKEN_A into the delegated mangoAccount", async () => {
//   const providerABefore = await getTokenAccount(
//     provider,
//     providerAATA
//   );
//   assert.ok(providerABefore.amount.eq(new anchor.BN(5000000)));

//   const group = await client.getMangoGroup(mangoGroupPubkey);
//   const rootBanks = await group.loadRootBanks(provider.connection);
//   const rootBankPubkeys = rootBanks
//     .map((rb) => rb?.publicKey)
//     .filter((pk) => pk !== undefined) as PublicKey[];
//   const tokenIndex = group.getTokenIndex(tokenA.publicKey);
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

//   const tx = await program.rpc.deposit(new anchor.BN(1000000), 15, {
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
// });
