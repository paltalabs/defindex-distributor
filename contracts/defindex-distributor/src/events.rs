use soroban_sdk::{contractevent, Address};

/// Emitted once per recipient after their df tokens are transferred.
///
/// - topics - `["distributed"]`
/// - data   - `[asset: Address, vault: Address, user: Address, underlying_amount: i128, df_tokens: i128]`
#[contractevent(topics = ["distributed"])]
pub struct Distributed {
    pub asset: Address,
    pub vault: Address,
    pub user: Address,
    pub underlying_amount: i128,
    pub df_tokens: i128,
}
