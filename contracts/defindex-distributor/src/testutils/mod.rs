//! Test utilities for the defindex-distributor integration tests.
//!
//! The main entry point is [`DistributorTestFixture`] and its
//! [`DistributorTestFixture::create`] constructor, which sets up the full
//! DeFindex stack in the test environment:
//!
//! 1. Blend protocol (comet, emitter, backstop, pool factory, lending pool)
//! 2. Soroswap (factory, router, BLND/USDC liquidity pair)
//! 3. Blend strategy contract
//! 4. DeFindex vault factory + vault (via factory)
//! 5. First deposit into the vault (establishes `MINIMUM_LIQUIDITY`)
//! 6. Rebalance – all idle funds invested into the Blend strategy
//! 7. Distributor contract ready for testing

pub mod blend_setup;
pub mod soroswap_setup;

pub use blend_setup::{
    BlendFixture, BlendPoolClient, EnvTestUtils, ONE_DAY_LEDGERS,
    create_blend_pool,
};
pub use soroswap_setup::{
    create_soroswap_factory, create_soroswap_pool, create_soroswap_router,
};

use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    vec, Address, BytesN, Env, IntoVal, Map, String, Val, Vec,
};

// ── Contract WASM imports ───────────────────────────────────────────────────────

mod factory_wasm {
    soroban_sdk::contractimport!(file = "external_wasms/defindex_factory.optimized.wasm");
    pub type FactoryClient<'a> = Client<'a>;
}
pub use factory_wasm::{AssetStrategySet, FactoryClient, Strategy};

pub mod vault_wasm {
    soroban_sdk::contractimport!(file = "external_wasms/defindex_vault.optimized.wasm");
    pub type VaultClient<'a> = Client<'a>;
}
pub use vault_wasm::{Instruction, VaultClient};

mod blend_strategy_wasm {
    soroban_sdk::contractimport!(file = "external_wasms/blend_strategy.optimized.wasm");
    pub type BlendStrategyClient<'a> = Client<'a>;
}
pub use blend_strategy_wasm::BlendStrategyClient;

// ── Constants ───────────────────────────────────────────────────────────────────

/// Shares permanently locked on first deposit (prevents vault from ever being
/// fully empty, avoiding division-by-zero in share price calculations).
pub const MINIMUM_LIQUIDITY: i128 = 1_000;
/// DeFindex protocol fee in basis-points (50 bps = 0.5%).
pub const DEFINDEX_FEE: u32 = 50;
/// Vault management fee in basis-points (100 bps = 1%).
pub const VAULT_FEE: u32 = 100;
/// USDC deposited by the setup user on fixture creation (1 000 USDC, 7 decimals).
pub const INITIAL_DEPOSIT: i128 = 1_000_0000000;

// ── Token helper ────────────────────────────────────────────────────────────────

/// Create a Stellar Asset Contract and return both a `TokenClient` (read-only)
/// and a `StellarAssetClient` (admin / minting).
pub fn create_token<'a>(
    e: &Env,
    admin: &Address,
) -> (TokenClient<'a>, StellarAssetClient<'a>) {
    let addr = e
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    (TokenClient::new(e, &addr), StellarAssetClient::new(e, &addr))
}

// ── Factory helper ──────────────────────────────────────────────────────────────

fn create_factory<'a>(
    e: &Env,
    admin: &Address,
    defindex_receiver: &Address,
    vault_wasm_hash: &BytesN<32>,
) -> FactoryClient<'a> {
    let args = (
        admin.clone(),
        defindex_receiver.clone(),
        DEFINDEX_FEE,
        vault_wasm_hash.clone(),
    );
    let addr = e.register(factory_wasm::WASM, args);
    FactoryClient::new(e, &addr)
}

// ── Blend strategy helper ───────────────────────────────────────────────────────

fn create_blend_strategy<'a>(
    e: &Env,
    asset: &Address,
    blend_pool: &Address,
    blend_token: &Address,
    soroswap_router: &Address,
    reward_threshold: i128,
    keeper: &Address,
) -> BlendStrategyClient<'a> {
    let init_args: Vec<Val> = vec![
        e,
        blend_pool.into_val(e),
        blend_token.into_val(e),
        soroswap_router.into_val(e),
        reward_threshold.into_val(e),
        keeper.into_val(e),
    ];
    let args = (asset.clone(), init_args);
    BlendStrategyClient::new(e, &e.register(blend_strategy_wasm::WASM, args))
}

// ── Fixture ─────────────────────────────────────────────────────────────────────

/// Everything a test needs to exercise the distributor against a live
/// DeFindex / Blend stack.
///
/// Created via [`DistributorTestFixture::create`].  All authorisations are
/// pre-mocked via `env.mock_all_auths()`.
#[allow(dead_code)]
pub struct DistributorTestFixture<'a> {
    pub env: Env,

    // ── Tokens ──
    /// The vault's underlying asset (USDC, 7 decimals).
    pub usdc: TokenClient<'a>,
    /// USDC admin client – use `.mint(to, amount)` in tests.
    pub usdc_admin: StellarAssetClient<'a>,
    /// BLND reward token (needed for Blend internals; rarely used directly).
    pub blnd_admin: StellarAssetClient<'a>,
    /// XLM collateral token (needed for the Blend pool second reserve).
    pub xlm_admin: StellarAssetClient<'a>,

    // ── Blend ──
    /// The Blend lending pool that the strategy deposits into.
    pub blend_pool: BlendPoolClient<'a>,

    // ── Strategy ──
    pub strategy: BlendStrategyClient<'a>,

    // ── Vault ──
    pub vault: VaultClient<'a>,
    /// Role 2 (Manager) – can call `vault.rebalance()`.
    pub manager: Address,
    /// Role 3 (RebalanceManager) – can also call `vault.rebalance()`.
    pub rebalance_manager: Address,
    /// Role 0 (EmergencyManager).
    pub emergency_manager: Address,
    /// Role 1 (VaultFeeReceiver).
    pub fee_receiver: Address,

    // ── Blend keeper ──
    /// Address authorised to call `strategy.harvest()`.
    pub keeper: Address,

    // ── Common admin ──
    /// Deployer of Blend, factory, and token admin.
    pub admin: Address,

    // ── Distributor ──
    /// The contract under test.
    pub distributor: crate::DistributorClient<'a>,

    // ── Setup state ──
    /// The first user who deposited into the vault (holds locked shares).
    pub setup_user: Address,
}

impl<'a> DistributorTestFixture<'a> {
    /// Build the full integration fixture:
    ///
    /// 1. Blend protocol deployed
    /// 2. Soroswap deployed with a BLND/USDC liquidity pool
    /// 3. Blend lending pool created with USDC + XLM reserves
    /// 4. Blend strategy deployed
    /// 5. DeFindex vault created via factory
    /// 6. First deposit (`INITIAL_DEPOSIT` USDC) → vault shares minted
    /// 7. Full rebalance → all idle funds sent to Blend strategy
    /// 8. Distributor contract registered
    pub fn create() -> DistributorTestFixture<'a> {
        let env = Env::default();
        env.set_default_info();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();

        // ── Generate key addresses ──────────────────────────────────────────────
        let admin = Address::generate(&env);
        let keeper = Address::generate(&env);
        let soroswap_admin = Address::generate(&env);

        // ── Create tokens (Stellar Asset Contracts) ─────────────────────────────
        let (blnd, blnd_admin) = create_token(&env, &admin);
        let (usdc, usdc_admin) = create_token(&env, &admin);
        let (_xlm, xlm_admin) = create_token(&env, &admin);

        // ── Soroswap setup ──────────────────────────────────────────────────────
        let soroswap_factory = create_soroswap_factory(&env, &soroswap_admin);
        let soroswap_router = create_soroswap_router(&env, &soroswap_factory.address);

        // Seed the BLND/USDC pair so the strategy can swap harvested BLND → USDC
        let pool_admin = Address::generate(&env);
        blnd_admin.mint(&pool_admin, &100_000_000_0_000_000_i128);
        usdc_admin.mint(&pool_admin, &50_000_000_0_000_000_i128);
        create_soroswap_pool(
            &env,
            &soroswap_router,
            &pool_admin,
            &blnd.address,
            &usdc.address,
            100_000_000_0_000_000_i128,
            50_000_000_0_000_000_i128,
        );

        // ── Blend protocol ──────────────────────────────────────────────────────
        let blend_fixture =
            BlendFixture::deploy(&env, &admin, &blnd.address, &usdc.address);

        let pool = create_blend_pool(
            &env,
            &blend_fixture,
            &admin,
            &usdc_admin,
            &xlm_admin,
        );
        let blend_pool = BlendPoolClient::new(&env, &pool);

        env.cost_estimate().budget().reset_unlimited();

        // ── Blend strategy ──────────────────────────────────────────────────────
        let strategy = create_blend_strategy(
            &env,
            &usdc.address,
            &pool,
            &blnd.address,
            &soroswap_router.address,
            40_0000000_i128, // reward threshold: 40 BLND
            &keeper,
        );

        // ── Vault factory + vault ───────────────────────────────────────────────
        let vault_wasm_hash = env
            .deployer()
            .upload_contract_wasm(vault_wasm::WASM);

        let defindex_receiver = Address::generate(&env);
        let factory = create_factory(&env, &admin, &defindex_receiver, &vault_wasm_hash);

        let manager = Address::generate(&env);
        let rebalance_manager = Address::generate(&env);
        let emergency_manager = Address::generate(&env);
        let fee_receiver = Address::generate(&env);

        let mut roles: Map<u32, Address> = Map::new(&env);
        roles.set(0_u32, emergency_manager.clone()); // EmergencyManager
        roles.set(1_u32, fee_receiver.clone());       // VaultFeeReceiver
        roles.set(2_u32, manager.clone());             // Manager
        roles.set(3_u32, rebalance_manager.clone());  // RebalanceManager

        let assets = vec![
            &env,
            AssetStrategySet {
                address: usdc.address.clone(),
                strategies: vec![
                    &env,
                    Strategy {
                        address: strategy.address.clone(),
                        name: String::from_str(&env, "Blend USDC Strategy"),
                        paused: false,
                    },
                ],
            },
        ];

        let mut name_symbol: Map<String, String> = Map::new(&env);
        name_symbol.set(
            String::from_str(&env, "name"),
            String::from_str(&env, "BlendVault"),
        );
        name_symbol.set(
            String::from_str(&env, "symbol"),
            String::from_str(&env, "BLNDVLT"),
        );

        let vault_address = factory.create_defindex_vault(
            &roles,
            &VAULT_FEE,
            &assets,
            &soroswap_router.address,
            &name_symbol,
            &true,
        );
        let vault = VaultClient::new(&env, &vault_address);

        // ── First deposit ───────────────────────────────────────────────────────
        // This establishes MINIMUM_LIQUIDITY in the vault so that the share price
        // is defined for all subsequent operations.
        let setup_user = Address::generate(&env);
        usdc_admin.mint(&setup_user, &INITIAL_DEPOSIT);
        vault.deposit(
            &vec![&env, INITIAL_DEPOSIT],
            &vec![&env, INITIAL_DEPOSIT],
            &setup_user,
            &false,
        );

        // ── Rebalance: invest all idle funds into the Blend strategy ────────────
        let invest_instructions = vec![
            &env,
            Instruction::Invest(strategy.address.clone(), INITIAL_DEPOSIT),
        ];
        vault.rebalance(&manager, &invest_instructions);

        env.cost_estimate().budget().reset_unlimited();

        // ── Distributor contract ────────────────────────────────────────────────
        let distributor_addr = env.register(crate::Distributor, ());
        let distributor = crate::DistributorClient::new(&env, &distributor_addr);

        DistributorTestFixture {
            env,
            usdc,
            usdc_admin,
            blnd_admin,
            xlm_admin,
            blend_pool,
            strategy,
            vault,
            manager,
            rebalance_manager,
            emergency_manager,
            fee_receiver,
            keeper,
            admin,
            distributor,
            setup_user,
        }
    }
}
