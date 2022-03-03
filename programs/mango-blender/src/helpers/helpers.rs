// Code from Mango V3 that I wish was public
// Really just a hacky implementation of MangoAccount.get_spot_val
use anchor_lang::prelude::*;
use fixed::types::I80F48;
use mango::error::MangoResult;
use mango::state::{RootBankCache, MAX_TOKENS, MAX_PAIRS, ZERO_I80F48, load_open_orders };
use mango::utils::split_open_orders;

pub fn get_mango_account_base_net(
    mango_deposits: [I80F48; MAX_TOKENS],
    mango_borrows: [I80F48; MAX_TOKENS],
    bank_cache: RootBankCache,
    token_index: usize,
) -> I80F48 {
    if mango_deposits[token_index].is_positive() {
        mango_deposits[token_index]
            .checked_mul(bank_cache.deposit_index)
            .unwrap()
    } else if mango_borrows[token_index].is_positive() {
        -mango_borrows[token_index]
            .checked_mul(bank_cache.borrow_index)
            .unwrap()
    } else {
        ZERO_I80F48
    }
}

/// Return the value (in quote tokens) for this market taking into account open orders
/// but not doing asset weighting
pub fn get_spot_val_in_quote(
    base_net: I80F48,
    price: I80F48,
    open_orders_ai: Option<&AccountInfo>,
    in_margin_basket: bool,
) -> MangoResult<I80F48> {
    if !in_margin_basket || open_orders_ai.is_none() {
        Ok(base_net * price)
    } else {
        let open_orders = load_open_orders(open_orders_ai.unwrap())?;
        let (quote_free, quote_locked, base_free, base_locked) = split_open_orders(&open_orders);

        // Two "worst-case" scenarios are considered:
        // 1. All bids are executed at current price, producing a base amount of bids_base_net
        //    when all quote_locked are converted to base.
        // 2. All asks are executed at current price, producing a base amount of asks_base_net
        //    because base_locked would be converted to quote.
        let bids_base_net: I80F48 = base_net + base_free + base_locked + quote_locked / price;
        let asks_base_net = base_net + base_free;

        // Report the scenario that would have a worse outcome on health.
        //
        // Explanation: This function returns (base, quote) and the values later get used in
        //     health += (if base > 0 { asset_weight } else { liab_weight }) * base + quote
        // and here we return the scenario that will increase health the least.
        //
        // Correctness proof:
        // - always bids_base_net >= asks_base_net
        // - note that scenario 1 returns (a + b, c)
        //         and scenario 2 returns (a,     c + b), and b >= 0, c >= 0
        // - if a >= 0: scenario 1 will lead to less health as asset_weight <= 1.
        // - if a < 0 and b <= -a: scenario 2 will lead to less health as liab_weight >= 1.
        // - if a < 0 and b > -a:
        //   The health contributions of both scenarios are identical if
        //       asset_weight * (a + b) + c = liab_weight * a + c + b
        //   <=> b = (asset_weight - liab_weight) / (1 - asset_weight) * a
        //   <=> b = -2 a  since asset_weight + liab_weight = 2 by weight construction
        //   So the worse scenario switches when a + b = -a.
        // That means scenario 1 leads to less health whenever |a + b| > |a|.

        if bids_base_net.abs() > asks_base_net.abs() {
            Ok((bids_base_net * price) + quote_free)
        } else {
            Ok((asks_base_net * price) + (base_locked * price + quote_free + quote_locked))
        }
    }
}


pub fn convert_open_orders_ais_to_keys(open_orders_ais: Vec<Option<&AccountInfo>>) -> [Pubkey; MAX_PAIRS] {
    let mut result = [Pubkey::default(); MAX_PAIRS];
    for (pos, open_orders_ai) in open_orders_ais.iter().enumerate() {
        let key = match open_orders_ai {
            Some(open_order) => *open_order.key,
            None => Pubkey::default(),
        };
        result[pos] = key;
    }
    result
}
