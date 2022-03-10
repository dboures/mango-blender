import { MangoClient } from "@blockworks-foundation/mango-client";
import { BN } from "@project-serum/anchor";
import { getMintInfo } from "@project-serum/common";
import { getTokenAccount } from "@saberhq/token-utils";
import { PublicKey } from "@solana/web3.js";
import { TEST_PROVIDER } from "./mango-blender";
import { MANGO_PROG_ID, SERUM_PROG_ID } from "./setupMango";
const assert = require("assert");

export async function checkIouMintSupply(poolIouAddress: PublicKey, expectedAmount: BN) {
    const iouMintInfo = await getMintInfo(TEST_PROVIDER, poolIouAddress);
    assert.ok(iouMintInfo.supply.eq(expectedAmount));
}

export async function checkProviderTokenAmount(providerTokenATA: PublicKey, expectedAmount: BN) {
    const providerIouAmount = await getTokenAccount(
        TEST_PROVIDER,
        providerTokenATA
      );
      assert.ok(providerIouAmount.amount.eq(expectedAmount));
}

export async function checkMangoAccountTokenAmount(mangoAccountAddress: PublicKey, tokenIndex: number, expectedUiAmount: number, exact = true) {
    const client = new MangoClient(TEST_PROVIDER.connection, MANGO_PROG_ID);
    const mangoAccount = await client.getMangoAccount(
        mangoAccountAddress,
        SERUM_PROG_ID
      );
    //   console.log(mangoAccount.deposits[tokenIndex].toNumber(), expectedUiAmount);
      if (exact) {
        assert.ok(mangoAccount.deposits[tokenIndex].toNumber() === expectedUiAmount);
      } else {
        const difference = Math.abs(mangoAccount.deposits[tokenIndex].toNumber() - expectedUiAmount);
        assert.ok(difference < 0.0001);
      }
}