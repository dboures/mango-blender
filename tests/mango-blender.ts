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

    [poolAddress, poolBump] = await PublicKey.findProgramAddress(
      [Buffer.from("pool", "utf-8")],
      program.programId
    );

    mangoGroupPubkey = await createMangoGroup(provider, payer);
    client = new MangoClient(provider.connection, MANGO_PROG_ID);
  });

  it("can create a liquidator pool", async () => {
    const tx = await program.rpc.createPool(poolBump, {
      accounts: {
        pool: poolAddress,
        admin: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      },
      signers: [payer],
    });

    const initializedPool = await program.account.pool.fetch(poolAddress);
    assert.ok(
      initializedPool.admin.toBase58() === provider.wallet.publicKey.toBase58()
    );
  });

  it("can create a mangoAccount owned by the pool", async () => {
    const newnew = Keypair.generate();
    const tx = await program.rpc.createMangoAccount(new anchor.BN(1), {
      accounts: {
        pool: poolAddress,
        admin: provider.wallet.publicKey,
        mangoProgram: MANGO_PROG_ID,
        mangoGroup: mangoGroupPubkey,
        mangoAccount: newnew.publicKey,
        systemProgram: SystemProgram.programId,
      },
      signers: [payer],
    });


  //assertion here

  });

});
