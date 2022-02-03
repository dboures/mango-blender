use anchor_lang::prelude::*;
use solana_program::program::invoke_signed;
use mango::instruction as MangoInstructions;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod mango_blender {
use super::*;
    pub fn create_pool(ctx: Context<CreatePool>, bump: u8) -> ProgramResult {
        // ctx.accounts.pool.vault = *ctx.accounts.admin.key;
        ctx.accounts.pool.admin = *ctx.accounts.admin.key;
        ctx.accounts.pool.bump = bump;
        Ok(())
    }

    pub fn create_mango_account(ctx: Context<CreateMangoAccount>, account_num: u64) -> ProgramResult {
         //Cross-program invocation with unauthorized signer or writable account !!

        //cpi to create mango account
        let create_instruction = MangoInstructions::create_mango_account(
            &ctx.accounts.mango_program.key(), 
            &ctx.accounts.mango_group.key(),
            &ctx.accounts.mango_account.key(), 
             &ctx.accounts.admin.key(), 
             &ctx.accounts.system_program.key(), 
             &ctx.accounts.admin.key(), 
             account_num)
             .unwrap();
    
        let seeds = &[ // TODO: add name, reintroduce pubkey
            b"pool".as_ref(),
            // ctx.accounts.pool.admin.as_ref(),
            &[ctx.accounts.pool.bump],
        ];
        
        invoke_signed(
            &create_instruction,
            &[
                ctx.accounts.mango_group.to_account_info().clone(),
                ctx.accounts.mango_account.to_account_info().clone(),
                ctx.accounts.admin.clone(),
                ctx.accounts.system_program.to_account_info().clone(),
                ctx.accounts.admin.clone(),
            ],
            &[&seeds[..]],
        )?;

        //cpi to set delegate to admin


        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(bump: u8)]
pub struct CreatePool<'info> {
    #[account(init, seeds = ["pool".as_ref()], bump = bump, payer = admin, space = 8 + 33)]
    pub pool: Account<'info, Pool>,
    #[account(signer)]
    pub admin: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateMangoAccount<'info> {
    pub pool: Account<'info, Pool>,
    #[account(signer)] // writable?
    pub admin: AccountInfo<'info>,
    // todo: check target program key
    pub mango_program: UncheckedAccount<'info>,
    // todo: check target group key
    pub mango_group: UncheckedAccount<'info>,
    #[account(mut)]
    pub mango_account: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Pool {
    pub bump: u8,       //1
    // pub vault: Pubkey, // 32
    pub admin: Pubkey, // 32
}
