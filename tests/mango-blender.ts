import * as anchor from "@project-serum/anchor";
import { Program, Provider } from "@project-serum/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  SingleConnectionBroadcaster,
  SolanaProvider,
} from "@saberhq/solana-contrib";
import { NodeWallet } from "@project-serum/common";
import { MangoBlender } from "../target/types/mango_blender";
import { createMangoGroup, MANGO_PROG_ID } from "./setupMango";
import { MangoClient } from "@blockworks-foundation/mango-client";
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

    mangoGroupPubkey = await createMangoGroup(provider, payer);
    client = new MangoClient(provider.connection, MANGO_PROG_ID);

    [mangoAccountAddress, mangoAccountBump] = await PublicKey.findProgramAddress(
      [mangoGroupPubkey.toBytes(), poolAddress.toBytes(), new anchor.BN(1).toArrayLike(Buffer, "le", 8)],
      MANGO_PROG_ID
    );
  });

  it("can create a liquidator pool, which includes a delegated mangoAccount for liqor", async () => {
    const accountNum = new anchor.BN(1)
    const tx = await program.rpc.createPool(poolNameBytes, poolBump, accountNum, {
      accounts: {
        pool: poolAddress,
        admin: provider.wallet.publicKey,
        mangoProgram: MANGO_PROG_ID,
        mangoGroup: mangoGroupPubkey,
        mangoAccount: mangoAccountAddress,
        systemProgram: SystemProgram.programId,
      },
      signers: [payer],
    });

    const initializedPool = await program.account.pool.fetch(poolAddress);
    assert.ok(
      initializedPool.admin.toBase58() === provider.wallet.publicKey.toBase58()
    );

    const mangoAccount = await client.getMangoAccount(mangoAccountAddress, MANGO_PROG_ID);
    assert.ok(mangoAccount.metaData.isInitialized);
    assert.ok(mangoAccount.delegate.equals(provider.wallet.publicKey))
  });


});
