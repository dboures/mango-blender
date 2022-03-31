use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};
use mango::instruction as MangoInstructions;
use solana_program::program::invoke_signed;

use crate::blender::state::Pool;

#[derive(Accounts)]
#[instruction(pool_name: String, bump: u8, iou_mint_bump: u8, fee_basis: u8)] // FUTURE: should be able to set a withdraw fee (in bps probably) // gm, from @STACCart // hey btw we can code the referrin mango account per perp order eh?

pub struct CreatePool<'info> {
    #[account(
        init, 
        seeds = [pool_name.as_ref(), admin.key.as_ref()], 
        bump, 
        payer = admin, 
        space = 8 + 32 + 32 + 32 + 1)]
    // ??? + admin Pkey + iou pkey + string + bump
    pub pool: Account<'info, Pool>,
    #[account(signer)]
    pub admin: AccountInfo<'info>,
    ///CHECK: checked in mango program
    pub mango_program: UncheckedAccount<'info>,
    #[account(mut)]
    ///CHECK: checked in mango program
    pub mango_group: UncheckedAccount<'info>,
    #[account(mut)]
    ///CHECK: checked in mango program
    pub mango_account: UncheckedAccount<'info>,
    #[account(
        init,
        mint::decimals = 6,
        mint::authority = pool,
        mint::freeze_authority = pool,
        seeds = [pool_name.as_ref(), admin.key.as_ref(), b"iou"],
        bump = iou_mint_bump,
        payer = admin
    )]
    pub pool_iou_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<CreatePool>,
    pool_name: String,
    pool_bump: u8,
    iou_mint_bump: u8,
    fee_basis: u8
) -> ProgramResult {
    ctx.accounts.pool.fee_basis = fee_basis;
    ctx.accounts.pool.pool_name = pool_name;
    ctx.accounts.pool.admin = *ctx.accounts.admin.key;
    ctx.accounts.pool.pool_bump = pool_bump;
    ctx.accounts.pool.iou_mint_bump = iou_mint_bump;
    ctx.accounts.pool.iou_mint = ctx.accounts.pool_iou_mint.key();

    //cpi to create mango account
    let create_instruction = MangoInstructions::create_mango_account(
        ctx.accounts.mango_program.key,
        ctx.accounts.mango_group.key,
        ctx.accounts.mango_account.key,
        ctx.accounts.pool.to_account_info().key,
        ctx.accounts.system_program.key,
        ctx.accounts.admin.key,
        1,
    )
    .unwrap();

    let seeds = &[
        &ctx.accounts.pool.pool_name.as_ref(),
        ctx.accounts.pool.admin.as_ref(),
        &[ctx.accounts.pool.pool_bump],
    ];
    let cpi_seed = &[&seeds[..]];

    invoke_signed(
        &create_instruction,
        &[
            ctx.accounts.mango_program.to_account_info().clone(),
            ctx.accounts.mango_group.to_account_info().clone(),
            ctx.accounts.mango_account.to_account_info().clone(),
            ctx.accounts.pool.to_account_info().clone(),
            ctx.accounts.system_program.to_account_info().clone(),
            ctx.accounts.admin.to_account_info().clone(),
        ],
        cpi_seed,
    )?;

    //cpi to set delegate to admin
    let delegate_instruction = MangoInstructions::set_delegate(
        ctx.accounts.mango_program.key,
        ctx.accounts.mango_group.key,
        ctx.accounts.mango_account.key,
        ctx.accounts.pool.to_account_info().key,
        ctx.accounts.admin.key,
    )
    .unwrap();

    invoke_signed(
        &delegate_instruction,
        &[
            ctx.accounts.mango_program.to_account_info().clone(),
            ctx.accounts.mango_group.to_account_info().clone(),
            ctx.accounts.mango_account.to_account_info().clone(),
            ctx.accounts.pool.to_account_info().clone(),
            ctx.accounts.admin.to_account_info().clone(),
        ],
        cpi_seed,
    )?;

    Ok(())
}
