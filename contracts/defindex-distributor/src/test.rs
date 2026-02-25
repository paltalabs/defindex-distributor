#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, vec, Address, Env, Vec};

mod integration {
    use super::*;
    use crate::testutils::{
        DistributorTestFixture, EnvTestUtils,
        INITIAL_DEPOSIT, MINIMUM_LIQUIDITY, ONE_DAY_LEDGERS,
        blend_setup::Request,
    };

    // ── Vault deposit verification ─────────────────────────────────────────────

    /// Verifies a single deposit into the vault:
    /// - df-tokens are minted and owned by the depositor
    /// - underlying USDC moves out of the depositor's wallet
    /// - vault's total_managed_funds grows by exactly the deposit amount
    /// - pro-rata share formula holds: df_minted = floor(amount * S / M)
    /// - immediate withdrawal value (get_asset_amounts_per_shares) ≤ deposited amount
    #[test]
    fn test_vault_deposit_verified() {
        let f = DistributorTestFixture::create();
        let env = &f.env;

        let user = Address::generate(env);
        let deposit_amount = 500_0000000_i128; // 500 USDC (7 decimals)
        f.usdc_admin.mint(&user, &deposit_amount);

        // Snapshot state before deposit
        let total_supply_before = f.vault.total_supply();
        let total_managed_before = f
            .vault
            .fetch_total_managed_funds()
            .get(0)
            .unwrap()
            .total_amount;

        // Deposit idle (invest=false so funds stay in vault, not pushed to strategy)
        let (_, df_minted, _) = f.vault.deposit(
            &vec![env, deposit_amount],
            &vec![env, 0_i128],
            &user,
            &false,
        );

        // df-tokens minted and held by user
        assert!(df_minted > 0, "deposit must mint df-tokens");
        assert_eq!(f.vault.balance(&user), df_minted);

        // USDC consumed from user
        assert_eq!(f.usdc.balance(&user), 0, "user USDC must be zero after deposit");

        // Pro-rata formula: shares = floor(deposit * total_supply / total_managed)
        let expected_shares = deposit_amount * total_supply_before / total_managed_before;
        assert_eq!(
            df_minted, expected_shares,
            "df_minted should match pro-rata formula"
        );

        // total_managed grew by exactly the deposit amount (idle funds)
        let total_managed_after = f
            .vault
            .fetch_total_managed_funds()
            .get(0)
            .unwrap()
            .total_amount;
        assert_eq!(total_managed_after, total_managed_before + deposit_amount);

        // Immediate withdrawal value must not exceed deposited amount
        // (floor rounding in share calc means user recovers ≤ what they put in)
        let user_underlying = f
            .vault
            .get_asset_amounts_per_shares(&df_minted)
            .get(0)
            .unwrap();
        assert!(
            user_underlying <= deposit_amount,
            "underlying {} must not exceed deposit {}", user_underlying, deposit_amount
        );
        assert!(user_underlying > 0, "recoverable underlying must be positive");
    }

    /// Deposits ten varied amounts and for each compares:
    ///   1. df-tokens minted (pro-rata formula)
    ///   2. underlying asset recoverable immediately after (get_asset_amounts_per_shares)
    ///
    /// Invariant: recoverable_underlying ≤ deposited_amount always holds because
    /// share minting uses floor division.  The delta is the rounding dust (≤ 1 strop).
    #[test]
    fn test_deposit_exchange_rate_ten_amounts() {
        let f = DistributorTestFixture::create();
        let env = &f.env;

        // Ten varied amounts at 7-decimal USDC scale
        let amounts: [i128; 10] = [
            1_0000000,          //      1.0000000 USDC
            7_3456789,          //      7.3456789 USDC
            42_0000000,         //     42.0000000 USDC
            100_5000000,        //    100.5000000 USDC
            333_3333333,        //    333.3333333 USDC
            500_0000000,        //    500.0000000 USDC
            1_000_0000000,      //  1 000.0000000 USDC
            2_500_0000001,      //  2 500.0000001 USDC
            10_000_0000000,     // 10 000.0000000 USDC
            99_9999999,         //     99.9999999 USDC
        ];

        for amount in amounts {
            let user = Address::generate(env);
            f.usdc_admin.mint(&user, &amount);

            // State before this particular deposit
            let total_supply = f.vault.total_supply();
            let total_managed = f
                .vault
                .fetch_total_managed_funds()
                .get(0)
                .unwrap()
                .total_amount;

            let (_, df_minted, _) = f.vault.deposit(
                &vec![env, amount],
                &vec![env, 0_i128],
                &user,
                &false,
            );

            // Basic sanity
            assert!(df_minted > 0, "df_minted must be > 0 for amount {}", amount);
            assert_eq!(
                f.vault.balance(&user), df_minted,
                "vault balance must equal df_minted for amount {}", amount
            );
            assert_eq!(
                f.usdc.balance(&user), 0,
                "user USDC must be 0 after deposit for amount {}", amount
            );

            // Pro-rata formula verification
            let expected = amount * total_supply / total_managed;
            assert_eq!(
                df_minted, expected,
                "df_minted must match pro-rata for amount {}", amount
            );

            // Recoverable underlying: what the user gets back if they withdraw now
            // Invariant: recoverable ≤ deposited  (floor division in share minting)
            let recoverable = f
                .vault
                .get_asset_amounts_per_shares(&df_minted)
                .get(0)
                .unwrap();

            assert!(
                recoverable <= amount,
                "amount {} | df_minted {} | recoverable {} — must not exceed deposited",
                amount, df_minted, recoverable
            );
            assert!(
                recoverable > 0,
                "recoverable underlying must be positive for amount {}", amount
            );

            // The rounding loss (amount - recoverable) should be at most 1 strop
            let dust = amount - recoverable;
            assert!(
                dust <= 1,
                "amount {} | df_minted {} | recoverable {} | dust {} — dust exceeds 1 strop",
                amount, df_minted, recoverable, dust
            );
        }
    }

    /// Full happy-path: fixture is created (blend pool + strategy + vault +
    /// first deposit + rebalance), then `distribute` splits freshly-minted
    /// vault shares between two recipients pro-rata.
    #[test]
    fn test_distribute_with_real_vault() {
        let f = DistributorTestFixture::create();
        let env = &f.env;

        let caller = Address::generate(env);
        let recipient1 = Address::generate(env);
        let recipient2 = Address::generate(env);

        // Give the caller enough USDC to distribute
        let deposit_total = 1_000_0000000_i128; // 1 000 USDC (7 decimals)
        f.usdc_admin.mint(&caller, &deposit_total);

        // Recipients' desired share of the underlying (60 / 40 split)
        let amount1 = 600_0000000_i128;
        let amount2 = 400_0000000_i128;
        let recipients: Vec<Recipient> = vec![
            env,
            Recipient { address: recipient1.clone(), amount: amount1 },
            Recipient { address: recipient2.clone(), amount: amount2 },
        ];

        // distribute() deposits `deposit_total` into the vault on behalf of
        // `caller`, then transfers the minted df-tokens to each recipient.
        let results = f.distributor.distribute(&caller, &f.vault.address, &recipients);

        // The vault should have issued some df-tokens
        let df1 = results.get(0).unwrap().1;
        let df2 = results.get(1).unwrap().1;
        assert!(df1 > 0, "recipient1 should have received df-tokens");
        assert!(df2 > 0, "recipient2 should have received df-tokens");
        // df1+df2 equals the total minted shares (not necessarily deposit_total because
        // the vault already has deposits and the share price is not exactly 1:1)
        assert_eq!(df1 + df2, f.vault.balance(&recipient1) + f.vault.balance(&recipient2));

        // Verify vault balances match
        assert_eq!(f.vault.balance(&recipient1), df1);
        assert_eq!(f.vault.balance(&recipient2), df2);
        // Caller should hold no leftover df-tokens
        assert_eq!(f.vault.balance(&caller), 0);
    }

    /// Verifies that the fixture itself is correctly set up:
    /// - vault has the blend strategy registered
    /// - setup_user deposit went through (shares minted, MINIMUM_LIQUIDITY locked)
    /// - after rebalance, vault's idle balance is zero (all in strategy)
    #[test]
    fn test_fixture_setup_state() {
        let f = DistributorTestFixture::create();

        // setup_user spent INITIAL_DEPOSIT and got shares = INITIAL_DEPOSIT - MINIMUM_LIQUIDITY
        let setup_user_shares = f.vault.balance(&f.setup_user);
        assert_eq!(setup_user_shares, INITIAL_DEPOSIT - MINIMUM_LIQUIDITY);

        // After rebalance the vault holds no idle USDC
        let vault_idle = f.usdc.balance(&f.vault.address);
        assert_eq!(vault_idle, 0);

        // All funds are in the blend strategy.
        // The Blend pool's b-rate arithmetic can round the reported balance by up to
        // MINIMUM_LIQUIDITY (1 000 strops) relative to the deposited amount.
        let strategy_bal = f.strategy.balance(&f.vault.address);
        assert!(
            strategy_bal >= INITIAL_DEPOSIT - MINIMUM_LIQUIDITY && strategy_bal <= INITIAL_DEPOSIT,
            "strategy balance should be ~INITIAL_DEPOSIT, got {}",
            strategy_bal
        );
    }

    /// After time passes and the blend pool accrues interest, the vault's
    /// total managed funds grow, meaning newly minted df-tokens are worth more
    /// than the deposited USDC (exchange rate > 1:1).  `distribute` should
    /// still apportion them correctly with no dust lost.
    #[test]
    fn test_distribute_after_yield_accrual() {
        let f = DistributorTestFixture::create();
        let env = &f.env;

        // Seed the pool with a borrower so interest actually accrues
        let borrower = Address::generate(env);
        f.usdc_admin.mint(&borrower, &500_0000000_i128);
        f.blend_pool.submit(
            &borrower,
            &borrower,
            &borrower,
            &vec![
                env,
                Request {
                    request_type: 2, // borrow
                    address: f.usdc.address.clone(),
                    amount: 500_0000000_i128,
                },
            ],
        );

        // Let a week pass so interest accrues
        env.jump(ONE_DAY_LEDGERS * 7);

        // Now distribute
        let caller = Address::generate(env);
        let recipient1 = Address::generate(env);
        let recipient2 = Address::generate(env);

        let amount = 200_0000000_i128;
        f.usdc_admin.mint(&caller, &amount);

        let recipients: Vec<Recipient> = vec![
            env,
            Recipient { address: recipient1.clone(), amount: 120_0000000_i128 },
            Recipient { address: recipient2.clone(), amount: 80_0000000_i128 },
        ];

        let results = f.distributor.distribute(&caller, &f.vault.address, &recipients);

        let df1 = results.get(0).unwrap().1;
        let df2 = results.get(1).unwrap().1;
        assert!(df1 > 0);
        assert!(df2 > 0);
        // After interest accrual the vault's share price is no longer 1:1 with the
        // underlying, so df_tokens_minted != amount.  What matters is that:
        //   (a) no dust is lost (df1+df2 == total minted == sum of vault balances)
        //   (b) caller holds nothing
        assert_eq!(df1 + df2, f.vault.balance(&recipient1) + f.vault.balance(&recipient2),
            "no df-tokens should be lost to rounding");

        assert_eq!(f.vault.balance(&recipient1), df1);
        assert_eq!(f.vault.balance(&recipient2), df2);
        assert_eq!(f.vault.balance(&caller), 0);
    }
}

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
    use soroban_sdk::{contract, contractimpl, symbol_short, vec, Address, Env, Map, Vec};

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
        /// Also accumulates the exchange-rate state used by
        /// `get_asset_amounts_per_shares`.
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

            // Track cumulative underlying and supply for get_asset_amounts_per_shares.
            let prev_und: i128 = e.storage().instance().get(&symbol_short!("und")).unwrap_or(0);
            let prev_sup: i128 = e.storage().instance().get(&symbol_short!("sup")).unwrap_or(0);
            e.storage().instance().set(&symbol_short!("und"), &(prev_und + total));
            e.storage().instance().set(&symbol_short!("sup"), &(prev_sup + df_minted));

            let mut bals = balances(&e);
            let cur = bals.get(from.clone()).unwrap_or(0);
            bals.set(from, cur + df_minted);
            save_bals(&e, &bals);

            (amounts_desired, df_minted, ())
        }

        /// Returns the underlying value of `vault_shares` shares.
        /// Mirrors the real vault's `get_asset_amounts_per_shares` interface
        /// (returns a single-element Vec for the one underlying asset).
        pub fn get_asset_amounts_per_shares(e: Env, vault_shares: i128) -> Vec<i128> {
            let total_und: i128 =
                e.storage().instance().get(&symbol_short!("und")).unwrap_or(0);
            let total_sup: i128 =
                e.storage().instance().get(&symbol_short!("sup")).unwrap_or(0);
            let amount = if total_sup == 0 {
                0
            } else {
                vault_shares * total_und / total_sup
            };
            vec![&e, amount]
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
    let recipients: Vec<Recipient> = vec![
        &env,
        Recipient { address: recipient1.clone(), amount: 300_i128 },
        Recipient { address: recipient2.clone(), amount: 700_i128 },
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
    let recipients: Vec<Recipient> = vec![
        &env,
        Recipient { address: recipient1.clone(), amount: 1_i128 },
        Recipient { address: recipient2.clone(), amount: 2_i128 },
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
    let recipients: Vec<Recipient> = vec![
        &env,
        Recipient { address: recipient1.clone(), amount: 3_i128 },
        Recipient { address: recipient2.clone(), amount: 3_i128 },
        Recipient { address: recipient3.clone(), amount: 3_i128 },
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

    let recipients: Vec<Recipient> = vec![
        &env,
        Recipient { address: recipient.clone(), amount: 500_i128 },
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

    let recipients: Vec<Recipient> = vec![
        &env,
        Recipient { address: users[0].clone(), amount: 1_i128 },
        Recipient { address: users[1].clone(), amount: 1_i128 },
        Recipient { address: users[2].clone(), amount: 2_i128 },
        Recipient { address: users[3].clone(), amount: 1_i128 },
        Recipient { address: users[4].clone(), amount: 2_i128 },
    ];

    let results = client.distribute(&caller, &vault_id, &recipients);

    let total_distributed: i128 = (0..5_u32).map(|i| results.get(i).unwrap().1).sum();
    assert_eq!(total_distributed, 13_i128);
    assert_eq!(vault.balance(&caller), 0_i128);
}
