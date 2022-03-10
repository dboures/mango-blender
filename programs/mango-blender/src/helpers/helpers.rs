use anchor_lang::prelude::*;
use fixed::types::I80F48;
use mango::error::MangoResult;
use mango::state::{
    load_open_orders, MangoAccount, MangoCache, MangoGroup,
    RootBankCache, UserActiveAssets, MAX_PAIRS, QUOTE_INDEX, ZERO_I80F48,
};
use mango::utils::split_open_orders;

/// Calculates the total value of the pooled MangoAccount in QUOTE (includes open orders)
pub fn calculate_pool_value(
    mango_account: &MangoAccount,
    mango_cache: &MangoCache,
    mango_group: &MangoGroup,
    open_orders_ais: Vec<Option<&AccountInfo>>,
    active_assets: &UserActiveAssets,
) -> I80F48 {
    let mut pool_value_quote = ZERO_I80F48;

    for i in 0..MAX_PAIRS {
        //spot
        if active_assets.spot[i] {
            let base_net = get_mango_account_base_net(
                mango_account,
                &mango_cache.root_bank_cache[i],
                i,
            );
            let price = mango_cache.get_price(i);
            let market_value_quote = get_spot_val_in_quote(
                base_net,
                price,
                open_orders_ais[i],
                mango_account.in_margin_basket[i],
            )
            .unwrap();
            pool_value_quote += market_value_quote;
        }
        //perp
        if active_assets.perps[i] {
            let (perp_base, perp_quote) = mango_account.perp_accounts[i].get_val(
                &mango_group.perp_markets[i],
                &mango_cache.perp_market_cache[i],
                mango_cache.price_cache[i].price,
            ).unwrap();
            pool_value_quote += perp_base + perp_quote;
        }
    }

    //quote
    let quote_value = get_mango_account_base_net(
        mango_account,
        &mango_cache.root_bank_cache[QUOTE_INDEX],
        QUOTE_INDEX,
    );
    pool_value_quote += quote_value;
    pool_value_quote
}

/// Copypasta of private fn get_net in mango-v3
pub fn get_mango_account_base_net(
    mango_account: &MangoAccount,
    bank_cache: &RootBankCache,
    token_index: usize,
) -> I80F48 {
    if mango_account.deposits[token_index].is_positive() {
        mango_account.deposits[token_index]
            .checked_mul(bank_cache.deposit_index)
            .unwrap()
    } else if mango_account.borrows[token_index].is_positive() {
        -mango_account.borrows[token_index]
            .checked_mul(bank_cache.borrow_index)
            .unwrap()
    } else {
        ZERO_I80F48
    }
}

/// Copypasta of private fn get_spot_val in mango-v3
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

pub fn convert_remaining_accounts_to_open_orders_keys(
    remaining_accounts: &[AccountInfo],
) -> [Pubkey; MAX_PAIRS] {
    let mut result = [Pubkey::default(); MAX_PAIRS];
    for (pos, account) in remaining_accounts.iter().enumerate() {
        result[pos] = *account.key;
    }
    result
}
