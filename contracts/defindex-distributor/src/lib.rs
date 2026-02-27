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
        asset: Address,
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

        let mut seen: Map<Address, ()> = Map::new(&e);
        let mut total: i128 = 0;
        for r in recipients.iter() {
            if r.amount <= 0 {
                panic!("each recipient amount must be positive");
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

        // ── 2. Pull underlying asset from caller into this contract ──────────
        let asset_token = TokenClient::new(&e, &asset);
        asset_token.transfer(&caller, &e.current_contract_address(), &total);

        // ── 3. Deposit into the defindex vault ────────────────────────────────
        // The vault pulls `total` of the underlying asset from this contract and
        // mints df tokens back to this contract.
        let vault_client = vault::Client::new(&e, &vault);

        e.authorize_as_current_contract(vec![
            &e,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: asset.clone(),
                    fn_name: Symbol::new(&e, "transfer"),
                    args: (
                        e.current_contract_address(),
                        vault.clone(),
                        total,
                    )
                        .into_val(&e),
                },
                sub_invocations: vec![&e],
            }),
        ]);

        let (_deposited, df_tokens_minted, _allocs) = vault_client.deposit(
            &vec![&e, total],
            &vec![&e, total],
            &e.current_contract_address(),
            &true,
        );

        // df tokens are already in this contract (vault minted them to e.current_contract_address())
        let df_token = TokenClient::new(&e, &vault);

        // ── 4. Distribute df tokens pro-rata to each recipient ────────────────
        // Each recipient contributed r.amount / total of the deposit, so they
        // receive r.amount / total * df_tokens_minted shares.
        // floor(r.amount * df_tokens_minted / total) — no extra vault call needed.

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
                r.amount.fixed_div_floor(&e, &total, &df_tokens_minted)
            };
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
            events::Distributed {
                asset: asset.clone(),
                vault: vault.clone(),
                user: r.address.clone(),
                underlying_amount: r.amount,
                df_tokens: user_df,
            }
            .publish(&e);
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

mod events;

#[cfg(test)]
mod testutils;

mod test;
