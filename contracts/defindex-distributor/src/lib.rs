#![no_std]
use soroban_fixed_point_math::SorobanFixedPoint;
use soroban_sdk::{
    contract, contractimpl, contracttype, token::TokenClient, vec, Address, Env, Map, Vec,
};
use soroban_sdk::auth::InvokerContractAuthEntry;
use soroban_sdk::auth::SubContractInvocation;
use soroban_sdk::auth::ContractContext;
use soroban_sdk::Symbol;
use soroban_sdk::IntoVal;

// Generated client for the defindex vault (deposit + SAC df token interface).
// The WASM is a pre-built external binary; Cargo dependency tracking and the
// /release/deps/ path convention do not apply here.
#[allow(unknown_lints, contract_import_dependency)]
mod vault {
    soroban_sdk::contractimport!(
        file = "external_wasms/defindex_vault.optimized.wasm"
    );
}

/// A single recipient entry passed to [`Distributor::distribute`].
///
/// Defining this as a `#[contracttype]` ensures the Vec parameter is composed
/// of validated, contract-defined types rather than raw tuples.
#[contracttype]
#[derive(Clone)]
pub struct Recipient {
    pub address: Address,
    pub amount: i128,
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
    ///   - underlying token transfer from `caller` to the vault (pulled internally by the vault)
    ///   - `vault_df_token.transfer(caller → userN, amountN)` for every recipient
    ///
    /// # Pro-rata note
    /// The vault may have a share price != 1:1 (e.g. 1 df token = 1.05 USDC if
    /// the vault has accrued yield).  As a result, the number of df tokens each
    /// user receives will differ from their input amount, but *proportionality*
    /// is preserved: a user who contributed X% of the total receives X% of the
    /// minted df tokens, which redeems for exactly X% of the deposited underlying.
    pub fn distribute(
        e: Env,
        caller: Address,
        vault: Address,
        recipients: Vec<Recipient>,
    ) -> Vec<(Address, i128)> {
        caller.require_auth();
        e.storage().instance().extend_ttl(17280, 17280 * 7);

        let n = recipients.len();

        // ── 1. Validate and sum all input amounts ─────────────────────────────
        if n == 0 {
            panic!("recipients must not be empty");
        }
        if n > 100 {
            panic!("too many recipients (max 100)");
        }

        let mut seen: Map<Address, ()> = Map::new(&e);
        let mut total: i128 = 0;
        for r in recipients.iter() {
            if r.amount <= 0 {
                panic!("each recipient amount must be positive");
            }
            if r.address == vault {
                panic!("recipient address must not be the vault");
            }
            if seen.contains_key(r.address.clone()) {
                panic!("duplicate recipient address");
            }
            seen.set(r.address.clone(), ());
            total = match total.checked_add(r.amount) {
                Some(v) => v,
                None => panic!("total overflow"),
            };
        }

        // ── 2. Deposit into the defindex vault ────────────────────────────────
        // The vault pulls `total` of the underlying asset from `caller` and
        // mints df tokens back to `caller`.
        let vault_client = vault::Client::new(&e, &vault);
        let (_deposited, df_tokens_minted, _allocs) = vault_client.deposit(
            &vec![&e, total], // amounts_desired  (single-asset vault)
            &vec![&e, total], // amounts_min
            &caller,          // from: source of funds AND recipient of df tokens
            &true,            // invest immediately
        );

        // Caller sends all the dftokens to the distributor contract
        let df_token = TokenClient::new(&e, &vault);
        df_token.transfer(&caller, &e.current_contract_address(), &df_tokens_minted);
        // From now on, all subsequent txs should be done by the distributor contract, not by the caller
        // This contract should generate the authorizations to transfer the df tokens to the recipients
        

        // ── 3. Get the authoritative price per share from the vault ───────────
        // Ask the vault how much underlying `df_tokens_minted` shares are worth.
        // This uses the vault's own exchange-rate calculation (post-deposit state)
        // rather than assuming the price equals the raw `total` input, which can
        // differ slightly due to rounding in the share-minting formula.
        let asset_amounts = vault_client.get_asset_amounts_per_shares(&df_tokens_minted);
        let underlying_for_minted: i128 = asset_amounts
            .get(0)
            .expect("vault must have at least one asset");

        // ── 4. Distribute df tokens from caller to each recipient ─────────────
        // The vault contract IS the df token (implements SAC).

        let mut distributed: i128 = 0;
        let mut results: Vec<(Address, i128)> = vec![&e];
        let mut i: u32 = 0;

        for r in recipients.iter() {
            // Use checked_add to detect last element without risking u32 overflow.
            let is_last = i.checked_add(1).map_or(false, |next| next == n);

            let user_df = if is_last {
                // Last recipient gets whatever is left to avoid losing dust.
                match df_tokens_minted.checked_sub(distributed) {
                    Some(v) => v,
                    None => panic!("underflow distributing last recipient"),
                }
            } else {
                // floor( r.amount * df_tokens_minted / underlying_for_minted )
                // Each recipient's share of df tokens is proportional to their
                // underlying contribution relative to the vault's authoritative
                // valuation of the total minted shares.
                r.amount.fixed_div_floor(&e, &underlying_for_minted, &df_tokens_minted)
            };
            // this contract should generate the authorizations to transfer the df tokens to the recipients
            // e.authorize_as_current_contract(vec![
            //     &e,
            //     InvokerContractAuthEntry::Contract(SubContractInvocation {
            //         context: ContractContext {
            //             contract: config.asset.clone(),
            //             fn_name: Symbol::new(&e, "transfer"),
            //             args: (
            //                 e.current_contract_address(),
            //                 config.pool.clone(),
            //                 amount.clone(),
            //             )
            //                 .into_val(e),
            //         },
            //         sub_invocations: vec![&e],
            //     }),
            // ]);
            // df token transfers should be done by the distributor contract (THIS)
            // this contract should generate the authorizations to transfer the df tokens to the recipients
            e.authorize_as_current_contract(vec![
                &e,
                InvokerContractAuthEntry::Contract(SubContractInvocation {
                    context: ContractContext {
                        contract: vault.clone(),
                        fn_name: Symbol::new(&e, "transfer"),
                        args: (
                            e.current_contract_address(),
                            r.address.clone(),
                            user_df.clone(),
                        )
                            .into_val(&e),
                    },
                    sub_invocations: vec![&e],
                }),
            ]);
            df_token.transfer(&e.current_contract_address(), &r.address, &user_df);
            distributed = match distributed.checked_add(user_df) {
                Some(v) => v,
                None => panic!("distributed overflow"),
            };
            results.push_back((r.address, user_df));
            i += 1;
        }

        results
    }
}

#[cfg(test)]
mod testutils;

mod test;
