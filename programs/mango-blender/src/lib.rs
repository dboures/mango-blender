use anchor_lang::prelude::*;
use blender::instructions::*;

mod blender;
mod helpers;

declare_id!("HzJMW7y12YSPDZMWNeqKDR51QnHwhF3TB96CZsPhpNoB");

#[program]
pub mod mango_blender {
    use super::*;

    pub fn create_pool(
        ctx: Context<CreatePool>,
        pool_name: String,
        pool_bump: u8,
        iou_mint_bump: u8,
    ) -> ProgramResult {
        blender::instructions::create_pool::handler(
            ctx,
            pool_name,
            pool_bump,
            iou_mint_bump,
        )
    }

    pub fn buy_into_pool(ctx: Context<BuyIntoPool>, quantity: u64) -> ProgramResult {
        blender::instructions::buy_into_pool::handler(ctx, quantity)
    }

    pub fn withdraw_from_pool<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, WithdrawFromPool<'info>>,
        quantity: u64,
    ) -> ProgramResult {
        blender::instructions::withdraw_from_pool::handler(ctx, quantity)
    }
}
