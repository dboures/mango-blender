use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod mango_blender {
    use super::*;
    pub fn create_pool(ctx: Context<CreatePool>, bump: u8) -> ProgramResult {
        // ctx.accounts.pool.vault = *ctx.accounts.admin.key;
        ctx.accounts.pool.admin = *ctx.accounts.admin.key;
        ctx.accounts.pool.bump = bump;

        //cpi to create mango account

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
    // #[account(constraint = arbiter.owner.key() != owner.key())]
    // pub arbiter: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Pool {
    pub bump: u8,       //1
    // pub vault: Pubkey, // 32
    pub admin: Pubkey, // 32
}
