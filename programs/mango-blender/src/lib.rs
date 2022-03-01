use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use fixed::types::I80F48;
use mango::declare_check_assert_macros;
use mango::error::{check_assert, MangoErrorCode, SourceFileId};
use mango::instruction as MangoInstructions;
use mango::state::{
    AssetType, MangoAccount, MangoCache, MangoGroup, UserActiveAssets, QUOTE_INDEX, ZERO_I80F48,
};
use solana_program::program::invoke_signed;
mod helpers;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

declare_check_assert_macros!(SourceFileId::Processor);

#[program]
pub mod mango_blender {
    use super::*;
    use crate::helpers::get_mango_account_base_net;
    use crate::helpers::get_spot_val_in_quote;
    use std::convert::TryFrom;
    pub fn create_pool(
        ctx: Context<CreatePool>,
        pool_name: String,
        pool_bump: u8,
        iou_mint_bump: u8,
        account_num: u64, // TODO: can't I just hardcode this to 1 always (1 pool = 1 mangoAccount)?
    ) -> ProgramResult {
        ctx.accounts.pool.pool_name = pool_name;
        ctx.accounts.pool.admin = *ctx.accounts.admin.key;
        ctx.accounts.pool.pool_bump = pool_bump;
        ctx.accounts.pool.iou_mint_bump = iou_mint_bump;
        ctx.accounts.pool.iou_mint = ctx.accounts.deposit_iou_mint.key();

        //cpi to create mango account
        let create_instruction = MangoInstructions::create_mango_account(
            ctx.accounts.mango_program.key,
            ctx.accounts.mango_group.key,
            ctx.accounts.mango_account.key,
            ctx.accounts.pool.to_account_info().key,
            ctx.accounts.system_program.key,
            ctx.accounts.admin.key,
            account_num,
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

    pub fn deposit(ctx: Context<Deposit>, quantity: u64, asset_index: u32) -> ProgramResult {
        // handle deposit
        let deposit_instruction = MangoInstructions::deposit(
            ctx.accounts.mango_program.key,
            ctx.accounts.mango_group.key,
            ctx.accounts.mango_account.key,
            ctx.accounts.depositor.key,
            ctx.accounts.mango_cache.key,
            ctx.accounts.root_bank.key,
            ctx.accounts.node_bank.key,
            ctx.accounts.vault.key,
            ctx.accounts.depositor_token_account.to_account_info().key,
            u64::try_from(quantity).unwrap(),
        )
        .unwrap();

        let seeds = &[
            &ctx.accounts.pool.pool_name.as_ref(),
            ctx.accounts.pool.admin.as_ref(),
            &[ctx.accounts.pool.pool_bump],
        ];
        let cpi_seed = &[&seeds[..]];

        invoke_signed(
            &deposit_instruction,
            &[
                ctx.accounts.mango_program.to_account_info().clone(),
                ctx.accounts.mango_group.to_account_info().clone(),
                ctx.accounts.mango_account.to_account_info().clone(),
                ctx.accounts.depositor.to_account_info().clone(),
                ctx.accounts.mango_cache.to_account_info().clone(),
                ctx.accounts.root_bank.to_account_info().clone(),
                ctx.accounts.node_bank.to_account_info().clone(),
                ctx.accounts.vault.to_account_info().clone(),
                ctx.accounts
                    .depositor_token_account
                    .to_account_info()
                    .clone(),
            ],
            cpi_seed,
        )?;

        // load mango account, group, cache
        let token_index = usize::try_from(asset_index).unwrap();
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

        // check that cache is valid
        let active_assets = UserActiveAssets::new(
            &mango_group,
            &mango_account,
            vec![(AssetType::Token, token_index)],
        );
        let clock = Clock::get()?;
        let now_ts = clock.unix_timestamp as u64;
        mango_cache.check_valid(&mango_group, &active_assets, now_ts)?;

        //TODO: check that asset index mint is the same as deposit_mint

        // Get value of deposit in quote native tokens
        let asset_price = mango_cache.get_price(token_index); // mango_cache price is interpreted as how many quote native tokens for 1 base native token
        let deposit_quantity = I80F48::from_num(quantity);
        check!(deposit_quantity > 0, MangoErrorCode::Default)?;
        let deposit_value_quote = asset_price.checked_mul(deposit_quantity).unwrap();

        // calculate total value of pool at current price (including open orders)
        let open_orders_ais =
            mango_account.checked_unpack_open_orders(&mango_group, &ctx.remaining_accounts)?;
        let mango_deposits = mango_account.deposits;
        let mango_borrows = mango_account.borrows;
        let mango_in_margin_basket = mango_account.in_margin_basket;

        let mut pool_value_quote = ZERO_I80F48;

        for i in 0..mango_group.num_oracles {
            let base_net = get_mango_account_base_net(
                mango_deposits,
                mango_borrows,
                mango_cache.root_bank_cache[i],
                i,
            );
            // msg!("i: {:?}", i);
            // msg!("base_net: {:?}", base_net);

            let price = mango_cache.get_price(i);
            // msg!("price: {:?}", price);
            let market_value_quote = get_spot_val_in_quote(
                base_net,
                price,
                open_orders_ais[i],
                mango_in_margin_basket[i],
            )
            .unwrap();
            // msg!("quote val: {:?}", market_value_quote);
            pool_value_quote += market_value_quote;
        }
        let quote_value = get_mango_account_base_net(
            mango_deposits,
            mango_borrows,
            mango_cache.root_bank_cache[QUOTE_INDEX],
            QUOTE_INDEX,
        );
        pool_value_quote += quote_value;
        // msg!("naked quote_value: {:?}", quote_value);

        msg!("deposit_value_quote: {:?}", deposit_value_quote);
        msg!("pool_value_quote: {:?}", pool_value_quote);

        let mint_accounts = MintTo {
            to: ctx.accounts.depositor_iou_token_account.to_account_info(),
            mint: ctx.accounts.deposit_iou_mint.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        };
        let token_program_ai = ctx.accounts.token_program.to_account_info();
        let iou_mint_ctx = CpiContext::new_with_signer(token_program_ai, mint_accounts, cpi_seed);

        // in case of first deposit
        if ctx.accounts.deposit_iou_mint.supply == 0 {
            let mint_amount: u64 = deposit_value_quote
                .checked_floor()
                .unwrap()
                .checked_to_num()
                .unwrap();
            msg!("mint_amount: {:?}", mint_amount);

            token::mint_to(iou_mint_ctx, mint_amount)?;
        } else {
            let outstanding_iou_tokens = I80F48::from_num(ctx.accounts.deposit_iou_mint.supply);
            // note that pool_value_quote is always >= deposit_value_quote, since we already deposited above
            let mint_amount: u64 = ((deposit_value_quote * outstanding_iou_tokens)
                / (pool_value_quote - deposit_value_quote))
                .checked_floor()
                .unwrap()
                .checked_to_num()
                .unwrap();
            msg!("mint_amount: {:?}", mint_amount);

            token::mint_to(iou_mint_ctx, mint_amount)?;
        }

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(pool_name: String, bump: u8, iou_mint_bump: u8)] // TODO: should be able to set a withdraw fee (in bps probably)
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
    pub mango_program: UncheckedAccount<'info>, // TODO
    #[account(mut)]
    pub mango_group: UncheckedAccount<'info>, // TODO
    #[account(mut)]
    pub mango_account: UncheckedAccount<'info>, // TODO
    #[account(
        init,
        mint::decimals = 6, // TODO : How many decimals should this be? Need to avoid errors
        mint::authority = pool,
        mint::freeze_authority = pool,
        seeds = [pool_name.as_ref(), admin.key.as_ref(), b"iou"],
        bump = iou_mint_bump,
        payer = admin
    )]
    pub deposit_iou_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub mango_program: UncheckedAccount<'info>, // TODO
    #[account(mut, seeds = [pool.pool_name.as_ref(), pool.admin.as_ref()], bump)]
    pub pool: Account<'info, Pool>, // Validation??
    pub mango_group: UncheckedAccount<'info>,   // TODO
    #[account(mut)]
    pub mango_account: UncheckedAccount<'info>, // TODO
    #[account(signer)]
    pub depositor: AccountInfo<'info>,
    pub mango_cache: UncheckedAccount<'info>, // TODO
    pub root_bank: UncheckedAccount<'info>,   // TODO
    #[account(mut)]
    pub node_bank: UncheckedAccount<'info>, // TODO
    #[account(mut)]
    pub vault: UncheckedAccount<'info>, // TODO
    #[account(mut, constraint = depositor_token_account.owner == depositor.key())]
    pub depositor_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [pool.pool_name.as_ref(), pool.admin.as_ref(), b"iou"],
        bump = pool.iou_mint_bump,
    )]
    pub deposit_iou_mint: Account<'info, Mint>,

    #[account(mut,
        associated_token::authority = depositor,
        associated_token::mint = deposit_iou_mint
    )]
    pub depositor_iou_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Pool {
    pub pool_name: String,         // Max of 32 characters
    pub pool_bump: u8,             //1
    pub iou_mint_bump: u8,         //1
    pub iou_mint: Pubkey,          // 32
    pub admin: Pubkey,             // 32
}
