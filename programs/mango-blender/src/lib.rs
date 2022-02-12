use anchor_spl::token::TokenAccount;
use anchor_lang::prelude::*;
use solana_program::program::invoke_signed;
use mango::instruction as MangoInstructions;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod mango_blender {
use super::*;
    pub fn create_pool(ctx: Context<CreatePool>, pool_name: String, bump: u8, account_num: u64) -> ProgramResult {
        ctx.accounts.pool.pool_name = pool_name;
        ctx.accounts.pool.admin = *ctx.accounts.admin.key;
        ctx.accounts.pool.bump = bump;

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

        Ok(())
    }


    pub fn deposit(ctx: Context<Deposit>, quantity: u64) -> ProgramResult {
        
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
            quantity
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
        //return iou tokens


        Ok(())
    }


}

#[derive(Accounts)]
#[instruction(pool_name: String, bump: u8)]
pub struct CreatePool<'info> {
    #[account(init, seeds = [pool_name.as_ref(), admin.key.as_ref()], bump, payer = admin, space = 8 + 33 + 32)]
    pub pool: Account<'info, Pool>,
    #[account(signer)]
    pub admin: AccountInfo<'info>,
    pub mango_program: UncheckedAccount<'info>,// TODO
    #[account(mut)]
    pub mango_group: UncheckedAccount<'info>,// TODO
    #[account(mut)]
    pub mango_account: UncheckedAccount<'info>,// TODO
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub mango_program: UncheckedAccount<'info>,// TODO
    #[account(seeds = [pool.pool_name.as_ref(), pool.admin.as_ref()], bump)]
    pub pool: Account<'info, Pool>, // Validation??
    pub mango_group: UncheckedAccount<'info>, // TODO
    #[account(mut)]
    pub mango_account: UncheckedAccount<'info>, // TODO
    #[account(signer)]
    pub depositor: AccountInfo<'info>,
    pub mango_cache: UncheckedAccount<'info>, // TODO
    pub root_bank: UncheckedAccount<'info>, // TODO
    #[account(mut)]
    pub node_bank: UncheckedAccount<'info>, // TODO
    #[account(mut)]
    pub vault: UncheckedAccount<'info>, // TODO
    #[account(mut)] // , constraint = depositor_token_account.owner == depositor.key()
    pub depositor_token_account: Account<'info, TokenAccount>,
    pub token_program: AccountInfo<'info>, // TODO
}

#[account]
pub struct Pool {
    pub bump: u8,       //1
    pub pool_name: String, // Max of 32 characters
    pub admin: Pubkey, // 32
}
