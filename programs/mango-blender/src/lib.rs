use anchor_lang::prelude::*;
use blender::instructions::*;

mod blender;
mod helpers;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod mango_blender {
    use super::*;

    pub fn create_pool(
        ctx: Context<CreatePool>,
        pool_name: String,
        pool_bump: u8,
        iou_mint_bump: u8,
        account_num: u64, // TODO: can't I just hardcode this to 1 always (1 pool = 1 mangoAccount)?
    ) -> ProgramResult {
        blender::instructions::create_pool::handler(
            ctx,
            pool_name,
            pool_bump,
            iou_mint_bump,
            account_num,
        )
    }

    pub fn deposit(ctx: Context<Deposit>, quantity: u64, asset_index: u32) -> ProgramResult {
        blender::instructions::deposit::handler(ctx, quantity, asset_index)
    }
}
