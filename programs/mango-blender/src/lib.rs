use fixed::types::I80F48;
use anchor_spl::token::TokenAccount;
use anchor_lang::prelude::*;
use solana_program::program::invoke_signed;
use mango::instruction as MangoInstructions;
use mango::state::{MangoAccount, MangoCache, MangoGroup, UserActiveAssets, AssetType};
use mango::declare_check_assert_macros;
use mango::error::{check_assert, SourceFileId, MangoErrorCode};


declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

declare_check_assert_macros!(SourceFileId::Processor);

#[program]
pub mod mango_blender {
use std::convert::TryFrom;
use super::*;
    pub fn create_pool(ctx: Context<CreatePool>, pool_name: String, bump: u8, account_num: u64) -> ProgramResult {
        ctx.accounts.pool.pool_name = pool_name;
        ctx.accounts.pool.admin = *ctx.accounts.admin.key;
        ctx.accounts.pool.bump = bump;
        ctx.accounts.pool.total_usdc_deposits = 0;

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
            &[ctx.accounts.pool.bump],
        ];
        
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
            &[&seeds[..]],
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
            &[&seeds[..]],
        )?;

        // create IOU token

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
            u64::try_from(quantity).unwrap()
        ).unwrap();

    
        let seeds = &[
            &ctx.accounts.pool.pool_name.as_ref(),
            ctx.accounts.pool.admin.as_ref(),
            &[ctx.accounts.pool.bump],
        ];
        
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
                ctx.accounts.depositor_token_account.to_account_info().clone(),
            ],
            &[&seeds[..]],
        )?;

        // calculate iou tokens
        let token_index = usize::try_from(asset_index).unwrap();
        let mango_account_ai = ctx.accounts.mango_account.to_account_info();
        let mango_group_ai = ctx.accounts.mango_group.to_account_info();
        let mango_cache_ai = ctx.accounts.mango_cache.to_account_info();

        let mango_account = MangoAccount::load_checked(&mango_account_ai, ctx.accounts.mango_program.key, ctx.accounts.mango_group.key)?;
        let mango_group = MangoGroup::load_checked(&mango_group_ai, ctx.accounts.mango_program.key).unwrap();
        let mango_cache = MangoCache::load_checked(&mango_cache_ai, ctx.accounts.mango_program.key, &mango_group)?;

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

        let deposit_value_usdc = asset_price.checked_mul(deposit_quantity).unwrap();

        // need total value of pool at current price -> going to be interesting, how do open orders come into play?


        msg!("active assets : {:?}", active_assets.spot);
        msg!("asset price : {}", asset_price);
        msg!("deposit quantity : {}", deposit_quantity);
        // panic!("Here's deposit_value_usdc just in case: {:?}", deposit_value_usdc);
        // let quote_root_bank_cache = &mango_cache.root_bank_cache[QUOTE_INDEX];
        //let goo = mango_account.get_native_deposit(quote_root_bank_cache, QUOTE_INDEX).unwrap();



        // return iou tokens



        Ok(())
    }


}

#[derive(Accounts)]
#[instruction(pool_name: String, bump: u8)]
pub struct CreatePool<'info> {
    #[account(init, seeds = [pool_name.as_ref(), admin.key.as_ref()], bump, payer = admin, space = 8 + 16 + 32 + 32 + 1)] // ??? + deposits + admin Pkey + string + bump
    pub pool: Account<'info, Pool>,
    #[account(signer)]
    pub admin: AccountInfo<'info>,
    pub mango_program: UncheckedAccount<'info>,// TODO
    #[account(mut)]
    pub mango_group: UncheckedAccount<'info>,// TODO
    #[account(mut)]
    pub mango_account: UncheckedAccount<'info>,// TODO
    pub system_program: Program<'info, System>,

    // TODO: should be able to set a withdraw fee
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub mango_program: UncheckedAccount<'info>,// TODO
    #[account(mut, seeds = [pool.pool_name.as_ref(), pool.admin.as_ref()], bump)]
    pub pool: Account<'info, Pool>, // Validation??
    pub mango_group: UncheckedAccount<'info>, // TODO
    #[account(mut)]
    pub mango_account: UncheckedAccount<'info>,// TODO
    #[account(signer)]
    pub depositor: AccountInfo<'info>,
    pub mango_cache: UncheckedAccount<'info>, // TODO
    pub root_bank: UncheckedAccount<'info>, // TODO
    #[account(mut)]
    pub node_bank: UncheckedAccount<'info>, // TODO
    #[account(mut)]
    pub vault: UncheckedAccount<'info>, // TODO
    #[account(mut, constraint = depositor_token_account.owner == depositor.key())]
    pub depositor_token_account: Account<'info, TokenAccount>,
    pub token_program: AccountInfo<'info>, // TODO

    // TODO: add deposit mint ??

    // TODO: add asset index
}

#[account]
pub struct Pool {
    pub bump: u8,       //1
    pub pool_name: String, // Max of 32 characters
    pub admin: Pubkey, // 32
    pub total_usdc_deposits: i128 // 16 -- Assuming only USDC for now, not sure best way to support all types of deposits, definitely need oracle, 
}

