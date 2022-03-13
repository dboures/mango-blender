use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};
use fixed::types::I80F48;
use mango::declare_check_assert_macros;
use mango::error::{check_assert, MangoErrorCode, SourceFileId};
use mango::instruction as MangoInstructions;
use mango::state::{AssetType, MangoAccount, MangoCache, MangoGroup, UserActiveAssets, MAX_PAIRS, QUOTE_INDEX};
use solana_program::program::invoke_signed_unchecked;

use crate::blender::state::Pool;
use crate::helpers::*;

declare_check_assert_macros!(SourceFileId::Processor);

#[derive(Accounts)]
pub struct WithdrawFromPool<'info> {
    ///CHECK: checked in mango program
    pub mango_program: UncheckedAccount<'info>,
    #[account(mut, seeds = [pool.pool_name.as_ref(), pool.admin.as_ref()], bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut)]
    ///CHECK: checked in mango program
    pub mango_group: UncheckedAccount<'info>,
    ///CHECK: checked in mango program
    pub mango_group_signer: UncheckedAccount<'info>,
    #[account(mut)]
    ///CHECK: checked in mango program
    pub mango_account: AccountInfo<'info>,
    #[account(signer)]
    pub withdrawer: AccountInfo<'info>,
    ///CHECK: checked in mango program
    pub mango_cache: UncheckedAccount<'info>,
    ///CHECK: checked in mango program
    pub root_bank: UncheckedAccount<'info>,
    #[account(mut)]
    ///CHECK: checked in mango program
    pub node_bank: UncheckedAccount<'info>,
    #[account(mut)]
    ///CHECK: checked in mango program
    pub vault: UncheckedAccount<'info>,
    #[account(mut, constraint = withdrawer_token_account.owner == withdrawer.key())]
    pub withdrawer_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [pool.pool_name.as_ref(), pool.admin.as_ref(), b"iou"],
        bump = pool.iou_mint_bump,
    )]
    pub pool_iou_mint: Box<Account<'info, Mint>>,

    #[account(mut,
        associated_token::authority = withdrawer,
        associated_token::mint = pool_iou_mint
    )]
    pub withdrawer_iou_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// A user can withdraw whatever token that they want from the pool, up to whatever % of the pool they own (as dictated by their iou tokens)
pub fn handler<'a, 'b, 'c, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, WithdrawFromPool<'info>>,
    quantity: u64,
) -> ProgramResult {
    // load mango account, group, cache
    let mango_account_ai = ctx.accounts.mango_account.to_account_info();
    let mango_group_ai = ctx.accounts.mango_group.to_account_info();
    let mango_cache_ai = ctx.accounts.mango_cache.to_account_info();

    let mango_account = MangoAccount::load_checked(
        &mango_account_ai,
        ctx.accounts.mango_program.key,
        ctx.accounts.mango_group.key,
    )?;
    let mango_group =
        MangoGroup::load_checked(&mango_group_ai, ctx.accounts.mango_program.key).unwrap();
    let mango_cache = MangoCache::load_checked(
        &mango_cache_ai,
        ctx.accounts.mango_program.key,
        &mango_group,
    )?;

    //check that user is withdrawing QUOTE from pool
    check!(
        mango_group.tokens[QUOTE_INDEX].mint == ctx.accounts.withdrawer_token_account.mint,
        MangoErrorCode::InvalidToken
    )?;

    // check that cache is valid
    let active_assets = UserActiveAssets::new(
        &mango_group,
        &mango_account,
        vec![(AssetType::Token, QUOTE_INDEX)],
    );
    let clock = Clock::get()?;
    let now_ts = clock.unix_timestamp as u64;
    mango_cache.check_valid(&mango_group, &active_assets, now_ts)?;

    //load open orders
    let open_orders_ais =
        mango_account.checked_unpack_open_orders(&mango_group, &ctx.remaining_accounts)?;

    // prepare iou burn
    let seeds = &[
        &ctx.accounts.pool.pool_name.as_ref(),
        ctx.accounts.pool.admin.as_ref(),
        &[ctx.accounts.pool.pool_bump],
    ];
    let cpi_seed = &[&seeds[..]];

    let burn_accounts = Burn {
        to: ctx.accounts.withdrawer_iou_token_account.to_account_info(),
        mint: ctx.accounts.pool_iou_mint.to_account_info(),
        authority: ctx.accounts.withdrawer.to_account_info(),
    };
    let token_program_ai = ctx.accounts.token_program.to_account_info();
    let iou_burn_ctx = CpiContext::new_with_signer(token_program_ai, burn_accounts, cpi_seed);

    // get values and burn amount
    let outstanding_iou_tokens = I80F48::from_num(ctx.accounts.pool_iou_mint.supply);
    let withdraw_value_quote = I80F48::from_num(quantity);
    let pool_value_quote = calculate_pool_value(
        &mango_account,
        &mango_cache,
        &mango_group,
        open_orders_ais,
        &active_assets,
    );
    let burn_amount = calculate_iou_burn_amount(
        withdraw_value_quote,
        pool_value_quote,
        outstanding_iou_tokens,
    );

    // make sure user has enough iou tokens to burn
    check!(burn_amount > 0, MangoErrorCode::Default)?;
    check!(
        burn_amount <= ctx.accounts.withdrawer_iou_token_account.amount,
        MangoErrorCode::InsufficientFunds
    )?;

    // FUTURE: add "withdrawal fee", either transfer some iou or QUOTE tokens to the mango manager

    token::burn(iou_burn_ctx, burn_amount)?;

    withdraw_from_mango(ctx, &mango_account.spot_open_orders, quantity)
}

/// Calculate how many iou tokens should be burned for a withdrawak
/// We want to ensure that a withdrawer can only withdraw what they are entitled to and that they burn the correct amount of iou tokens
/// e.g. If the pool is worth $100 and I own 10% of all minted iou tokens, I should be entitled to withdraw $10 worth of quote (aka 10% of the pool)
///
/// To achieve this: (withdraw value / starting pool value) = (my burnable iou tokens / outstanding iou tokens)
fn calculate_iou_burn_amount(
    withdraw_value_quote: I80F48,
    pool_value_quote: I80F48,
    outstanding_iou_tokens: I80F48,
) -> u64 {
    let burn_amount: u64 = ((withdraw_value_quote / pool_value_quote) * outstanding_iou_tokens)
        .checked_ceil()
        .unwrap()
        .checked_to_num()
        .unwrap();
    burn_amount
}

#[inline(never)]
fn withdraw_from_mango<'a, 'b, 'c, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, WithdrawFromPool<'info>>,
    open_orders_keys: &[Pubkey; MAX_PAIRS],
    quantity: u64,
) -> ProgramResult {
    let seeds = &[
        &ctx.accounts.pool.pool_name.as_ref(),
        ctx.accounts.pool.admin.as_ref(),
        &[ctx.accounts.pool.pool_bump],
    ];
    let cpi_seed = &[&seeds[..]];

    // handle withdraw (Mango will prevent if the account is too leveraged -- no borrows allowed)
    let withdraw_instruction = MangoInstructions::withdraw(
        ctx.accounts.mango_program.key,
        ctx.accounts.mango_group.key,
        ctx.accounts.mango_account.key,
        ctx.accounts.pool.to_account_info().key,
        ctx.accounts.mango_cache.key,
        ctx.accounts.root_bank.key,
        ctx.accounts.node_bank.key,
        ctx.accounts.vault.key,
        ctx.accounts.withdrawer_token_account.to_account_info().key,
        ctx.accounts.mango_group_signer.key,
        open_orders_keys,
        quantity,
        false,
    )
    .unwrap();

    // https://github.com/solana-labs/solana/issues/20311
    // https://github.com/solana-labs/solana/blob/master/sdk/program/src/program.rs
    invoke_signed_unchecked(
        &withdraw_instruction,
        &[
            ctx.accounts.mango_program.to_account_info(),
            ctx.accounts.mango_group.to_account_info(),
            ctx.accounts.mango_account.to_account_info(),
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.mango_cache.to_account_info(),
            ctx.accounts.root_bank.to_account_info(),
            ctx.accounts.node_bank.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.withdrawer_token_account.to_account_info(),
            ctx.accounts.mango_group_signer.to_account_info().clone(),
            ctx.accounts.token_program.to_account_info().clone(),
            ctx.remaining_accounts[0].to_account_info(),
            ctx.remaining_accounts[1].to_account_info(),
            ctx.remaining_accounts[2].to_account_info(),
            ctx.remaining_accounts[3].to_account_info(),
            ctx.remaining_accounts[4].to_account_info(),
            ctx.remaining_accounts[5].to_account_info(),
            ctx.remaining_accounts[6].to_account_info(),
            ctx.remaining_accounts[7].to_account_info(),
            ctx.remaining_accounts[8].to_account_info(),
            ctx.remaining_accounts[9].to_account_info(),
            ctx.remaining_accounts[10].to_account_info(),
            ctx.remaining_accounts[11].to_account_info(),
            ctx.remaining_accounts[12].to_account_info(),
            ctx.remaining_accounts[13].to_account_info(),
            ctx.remaining_accounts[14].to_account_info(),
        ],
        cpi_seed,
    )?;

    Ok(())
}
