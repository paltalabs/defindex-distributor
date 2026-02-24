#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, vec, Address, Env, Vec};

// ── Mock vault ────────────────────────────────────────────────────────────────
//
// Stands in for the real defindex vault on the SAME address for both roles:
//
//   • vault::Client::deposit()  — the distributor calls this to deposit and
//                                 receive df_tokens_minted back.
//   • TokenClient::transfer()   — the distributor calls this to move df tokens
//                                 from caller to each recipient.
//
// By default deposit mints df tokens 1:1 with the input.
// Call preset_df_mint() before distribute() to override the minted amount and
// test non-trivial exchange rates / floor rounding.

mod mock_vault {
    use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Map, Vec};

    fn balances(e: &Env) -> Map<Address, i128> {
        e.storage()
            .instance()
            .get(&symbol_short!("bals"))
            .unwrap_or(Map::new(e))
    }

    fn save_bals(e: &Env, b: &Map<Address, i128>) {
        e.storage().instance().set(&symbol_short!("bals"), b);
    }

    #[contract]
    pub struct MockVault;

    #[contractimpl]
    impl MockVault {
        /// Override how many df tokens deposit() will mint (ignores actual amounts).
        /// Call this before distribute() to simulate non-1:1 exchange rates.
        pub fn preset_df_mint(e: Env, amount: i128) {
            e.storage().instance().set(&symbol_short!("preset"), &amount);
        }

        // ── vault interface ───────────────────────────────────────────────────

        /// Mints df tokens to `from`.  Uses preset if set, otherwise 1:1.
        /// Third element is `()` which decodes as `Option::None` on the caller
        /// side — matching the real vault's return type.
        pub fn deposit(
            e: Env,
            amounts_desired: Vec<i128>,
            _amounts_min: Vec<i128>,
            from: Address,
            _invest: bool,
        ) -> (Vec<i128>, i128, ()) {
            let mut total: i128 = 0;
            for a in amounts_desired.iter() {
                total += a;
            }
            let df_minted: i128 = e
                .storage()
                .instance()
                .get(&symbol_short!("preset"))
                .unwrap_or(total); // default: 1:1

            let mut bals = balances(&e);
            let cur = bals.get(from.clone()).unwrap_or(0);
            bals.set(from, cur + df_minted);
            save_bals(&e, &bals);

            (amounts_desired, df_minted, ())
        }

        // ── SEP-41 token interface (df token = vault address) ─────────────────

        pub fn transfer(e: Env, from: Address, to: Address, amount: i128) {
            let mut bals = balances(&e);
            let f = bals.get(from.clone()).unwrap_or(0);
            let t = bals.get(to.clone()).unwrap_or(0);
            bals.set(from, f - amount);
            bals.set(to, t + amount);
            save_bals(&e, &bals);
        }

        // ── test helper ───────────────────────────────────────────────────────

        pub fn balance(e: Env, address: Address) -> i128 {
            balances(&e).get(address).unwrap_or(0)
        }
    }
}

use mock_vault::MockVaultClient;

// ── setup helper ──────────────────────────────────────────────────────────────

fn setup(e: &Env) -> (Address, DistributorClient<'_>) {
    let vault_id = e.register(mock_vault::MockVault, ());
    let distributor_id = e.register(Distributor, ());
    (vault_id, DistributorClient::new(e, &distributor_id))
}

// ── tests ─────────────────────────────────────────────────────────────────────

/// Basic two-recipient, 1:1 mock rate — exact split, no rounding.
#[test]
fn test_two_recipients_exact_split() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, client) = setup(&env);
    let vault = MockVaultClient::new(&env, &vault_id);

    let caller     = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    // total=1000, df_minted=1000 (1:1 default)
    // user1: floor(300*1000/1000) = 300
    // user2 (last): 1000 - 300 = 700
    let recipients: Vec<(Address, i128)> = vec![
        &env,
        (recipient1.clone(), 300_i128),
        (recipient2.clone(), 700_i128),
    ];

    let results = client.distribute(&caller, &vault_id, &recipients);

    assert_eq!(results.get(0).unwrap(), (recipient1.clone(), 300_i128));
    assert_eq!(results.get(1).unwrap(), (recipient2.clone(), 700_i128));
    assert_eq!(vault.balance(&recipient1), 300_i128);
    assert_eq!(vault.balance(&recipient2), 700_i128);
    assert_eq!(vault.balance(&caller), 0_i128);
}

/// Vault rate is non-1:1 (3 input → 10 df tokens).
/// Verifies floor division: floor(1 * 10 / 3) = 3, remainder goes to last.
#[test]
fn test_uneven_split_floors_correctly() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, client) = setup(&env);
    let vault = MockVaultClient::new(&env, &vault_id);

    let caller     = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    // Simulate vault issuing 10 df tokens for a 3-unit deposit (non-1:1)
    vault.preset_df_mint(&10_i128);

    // total=3, df_minted=10
    // user1: floor(1 * 10 / 3) = floor(3.33) = 3
    // user2 (last): 10 - 3 = 7
    let recipients: Vec<(Address, i128)> = vec![
        &env,
        (recipient1.clone(), 1_i128),
        (recipient2.clone(), 2_i128),
    ];

    let results = client.distribute(&caller, &vault_id, &recipients);

    assert_eq!(results.get(0).unwrap(), (recipient1.clone(), 3_i128));
    assert_eq!(results.get(1).unwrap(), (recipient2.clone(), 7_i128));
    assert_eq!(vault.balance(&recipient1), 3_i128);
    assert_eq!(vault.balance(&recipient2), 7_i128);
}

/// Remainder from rounding goes to the last recipient, not lost as dust.
#[test]
fn test_rounding_remainder_goes_to_last() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, client) = setup(&env);
    let vault = MockVaultClient::new(&env, &vault_id);

    let caller     = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    let recipient3 = Address::generate(&env);

    // Vault issues 10 df tokens for 9 units in (non-1:1)
    vault.preset_df_mint(&10_i128);

    // total=9, df_minted=10
    // user1: floor(3 * 10 / 9) = floor(3.33) = 3
    // user2: floor(3 * 10 / 9) = floor(3.33) = 3
    // user3 (last): 10 - 3 - 3 = 4  (gets remainder, not floor(3.33)=3)
    let recipients: Vec<(Address, i128)> = vec![
        &env,
        (recipient1.clone(), 3_i128),
        (recipient2.clone(), 3_i128),
        (recipient3.clone(), 3_i128),
    ];

    let results = client.distribute(&caller, &vault_id, &recipients);

    assert_eq!(results.get(0).unwrap(), (recipient1.clone(), 3_i128));
    assert_eq!(results.get(1).unwrap(), (recipient2.clone(), 3_i128));
    assert_eq!(results.get(2).unwrap(), (recipient3.clone(), 4_i128));
    assert_eq!(vault.balance(&recipient3), 4_i128);
}

/// Single recipient always hits the "last" path and receives all df tokens.
#[test]
fn test_single_recipient_gets_all_df_tokens() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, client) = setup(&env);
    let vault = MockVaultClient::new(&env, &vault_id);

    let caller    = Address::generate(&env);
    let recipient = Address::generate(&env);

    // Vault issues 999 df tokens for 500 units in
    vault.preset_df_mint(&999_i128);

    let recipients: Vec<(Address, i128)> = vec![
        &env,
        (recipient.clone(), 500_i128),
    ];

    let results = client.distribute(&caller, &vault_id, &recipients);

    assert_eq!(results.get(0).unwrap(), (recipient.clone(), 999_i128));
    assert_eq!(vault.balance(&recipient), 999_i128);
    assert_eq!(vault.balance(&caller), 0_i128);
}

/// Sum of all distributed df tokens must equal df_tokens_minted — no dust lost.
#[test]
fn test_no_df_tokens_lost_to_rounding() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault_id, client) = setup(&env);

    let caller = Address::generate(&env);

    let vault = MockVaultClient::new(&env, &vault_id);
    // 7 inputs → 13 df tokens: guarantees non-trivial rounding
    vault.preset_df_mint(&13_i128);

    let users: [Address; 5] = core::array::from_fn(|_| Address::generate(&env));

    let recipients: Vec<(Address, i128)> = vec![
        &env,
        (users[0].clone(), 1_i128),
        (users[1].clone(), 1_i128),
        (users[2].clone(), 2_i128),
        (users[3].clone(), 1_i128),
        (users[4].clone(), 2_i128),
    ];

    let results = client.distribute(&caller, &vault_id, &recipients);

    let total_distributed: i128 = (0..5_u32).map(|i| results.get(i).unwrap().1).sum();
    assert_eq!(total_distributed, 13_i128);
    assert_eq!(vault.balance(&caller), 0_i128);
}
