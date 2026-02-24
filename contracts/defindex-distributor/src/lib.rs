#![no_std]
use soroban_fixed_point_math::SorobanFixedPoint;
use soroban_sdk::{contract, contractimpl, token::TokenClient, vec, Address, Env, Vec};

// Generated client for the defindex vault (deposit + SEP-41 df token interface).
mod vault {
    soroban_sdk::contractimport!(
        file = "external_wasms/defindex_vault.optimized.wasm"
    );
}

#[contract]
pub struct Distributor;

#[contractimpl]
impl Distributor {
    /// Deposits the sum of all recipient amounts into a defindex vault on behalf
    /// of `caller`, then distributes the minted df tokens back to each recipient
    /// pro-rata (floor).  The last recipient absorbs any remainder from rounding.
    ///
    /// Returns `[(user, df_tokens_received)]` in the same order as `recipients`.
    ///
    /// # Auth
    /// `caller` must authorise this invocation AND the nested sub-invocations:
    ///   - `token.transfer(caller → vault, total)`   (pulled by the vault internally)
    ///   - `vault_df_token.transfer(caller → userN, amountN)` for every recipient
    ///
    /// # Pro-rata note
    /// Because the vault's share price may differ from 1:1, the df tokens each
    /// user ends up with represent the correct *proportion* of the deposited
    /// underlying, but the underlying equivalent per user ≠ their input amount.
    pub fn distribute(
        e: Env,
        caller: Address,
        vault: Address,
        token: Address,
        recipients: Vec<(Address, i128)>,
    ) -> Vec<(Address, i128)> {
        caller.require_auth();
        e.storage().instance().extend_ttl(17280, 17280 * 7);

        let _ = &token; // underlying asset; the vault pulls it from caller internally

        // ── 1. Sum all input amounts ──────────────────────────────────────────
        let mut total: i128 = 0;
        for (_, amount) in recipients.iter() {
            total += amount;
        }

        // ── 2. Deposit into the defindex vault ────────────────────────────────
        // The vault pulls `total` of the underlying asset from `caller` and
        // mints df tokens back to `caller`.  We only need the minted df_tokens amount minted.
        let vault_client = vault::Client::new(&e, &vault);
        let (_deposited, df_tokens_minted, _allocs) = vault_client.deposit(
            &vec![&e, total], // amounts_desired  (single-asset vault)
            &vec![&e, total], // amounts_min
            &caller,          // from: source of funds AND recipient of df tokens
            &true,            // invest immediately
        );

        // ── 3. Distribute df tokens from caller to each recipient ─────────────
        // The vault contract IS the df token (implements SAC).
        let df_token = TokenClient::new(&e, &vault);

        let n = recipients.len();
        let mut distributed: i128 = 0;
        let mut results: Vec<(Address, i128)> = vec![&e];
        let mut i: u32 = 0;

        for (user, amount) in recipients.iter() {
            let user_df = if i == n - 1 {
                // Last recipient gets whatever is left to avoid losing dust.
                df_tokens_minted - distributed
            } else {
                // floor( amount * df_tokens_minted / total )
                amount.fixed_div_floor(&e, &total, &df_tokens_minted)
            };

            df_token.transfer(&caller, &user, &user_df);
            distributed += user_df;
            results.push_back((user, user_df));
            i += 1;
        }

        results
    }
}

mod test;
