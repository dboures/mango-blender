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


    // pub fn deposit(ctx: Context<Deposit>) -> ProgramResult {
        // handle deposit
        // calculate iou tokens
        //return iou tokens
    //     Ok(())
    // }


}

#[derive(Accounts)]
#[instruction(pool_name: String, bump: u8)]
pub struct CreatePool<'info> {
    #[account(init, seeds = [pool_name.as_ref(), admin.key.as_ref()], bump, payer = admin, space = 8 + 33 + 32)]
    pub pool: Account<'info, Pool>,
    #[account(signer)]
    pub admin: AccountInfo<'info>,
    // todo: check target program key
    pub mango_program: UncheckedAccount<'info>,
    // todo: check target group key
    #[account(mut)]
    pub mango_group: UncheckedAccount<'info>,
    #[account(mut)]
    pub mango_account: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// #[derive(Accounts)]
// #[instruction(bump: u8)]
// pub struct Deposit<'info> {
//     pub pool: Account<'info, Pool>,
//     #[account(signer)]
//     pub admin: AccountInfo<'info>,
//     // todo: check target program key
//     pub mango_program: UncheckedAccount<'info>,
//     // todo: check target group key
//     #[account(mut)]
//     pub mango_group: UncheckedAccount<'info>,
//     #[account(mut)]
//     pub mango_account: UncheckedAccount<'info>,
//     pub system_program: Program<'info, System>,
// }

#[account]
pub struct Pool {
    pub bump: u8,       //1
    pub pool_name: String, // Max of 32 characters
    pub admin: Pubkey, // 32
}
