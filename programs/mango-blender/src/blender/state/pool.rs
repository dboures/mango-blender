use anchor_lang::prelude::*;

#[account]
///Comments here
pub struct Pool {
    pub pool_name: String, // Max of 32 characters
    pub pool_bump: u8,     //1
    pub iou_mint_bump: u8, //1
    pub iou_mint: Pubkey,  // 32
    pub admin: Pubkey,     // 32
    pub fee_basis: u8,
}
// const_assert!(std::mem::size_of::<Pool>() == 1 + 1 + 32 + 32 + 32);
