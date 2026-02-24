use soroban_sdk::{
    testutils::{Address as _, BytesN as _, Ledger as _, LedgerInfo},
    token::StellarAssetClient,
    vec, Address, BytesN, Env, String, Symbol, Vec,
};

pub const ONE_DAY_LEDGERS: u32 = 86400 / 5;

// ── Blend WASM imports ──────────────────────────────────────────────────────────

pub mod comet {
    soroban_sdk::contractimport!(file = "external_wasms/comet.wasm");
}

pub mod backstop {
    soroban_sdk::contractimport!(file = "external_wasms/backstop.wasm");
}
use backstop::Client as BackstopClient;

pub mod emitter {
    soroban_sdk::contractimport!(file = "external_wasms/emitter.wasm");
}

pub mod pool_factory {
    soroban_sdk::contractimport!(file = "external_wasms/pool_factory.wasm");
}
use pool_factory::{Client as PoolFactoryClient, PoolInitMeta};

pub mod pool {
    soroban_sdk::contractimport!(file = "external_wasms/pool.wasm");
}
pub use pool::{Client as BlendPoolClient, Request, ReserveConfig, ReserveEmissionMetadata};

// ── Mock oracle (SEP-40 v2 compatible) ─────────────────────────────────────────
//
// Implements the oracle interface the blend pool expects, without depending on
// the sep-40-oracle crate (which is tied to an older soroban-sdk version).

mod mock_oracle {
    use soroban_sdk::{
        contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec,
    };

    const KEY_ASSETS: Symbol = symbol_short!("assets");
    const KEY_PRICES: Symbol = symbol_short!("prices");
    const KEY_DEC: Symbol = symbol_short!("dec");
    const KEY_RES: Symbol = symbol_short!("res");
    const KEY_BASE: Symbol = symbol_short!("base");

    #[contracttype]
    #[derive(Clone, PartialEq)]
    pub enum Asset {
        Stellar(Address),
        Other(Symbol),
    }

    #[contracttype]
    #[derive(Clone)]
    pub struct PriceData {
        pub price: i128,
        pub timestamp: u64,
    }

    #[contract]
    pub struct MockOracle;

    #[contractimpl]
    impl MockOracle {
        pub fn set_data(
            e: Env,
            _admin: Address,
            base: Asset,
            assets: Vec<Asset>,
            decimals: u32,
            resolution: u32,
        ) {
            e.storage().instance().set(&KEY_BASE, &base);
            e.storage().instance().set(&KEY_ASSETS, &assets);
            e.storage().instance().set(&KEY_DEC, &decimals);
            e.storage().instance().set(&KEY_RES, &resolution);
        }

        pub fn set_price_stable(e: Env, prices: Vec<i128>) {
            e.storage().instance().set(&KEY_PRICES, &prices);
        }

        pub fn base(e: Env) -> Asset {
            e.storage().instance().get(&KEY_BASE).unwrap()
        }

        pub fn decimals(e: Env) -> u32 {
            e.storage().instance().get(&KEY_DEC).unwrap_or(7)
        }

        pub fn resolution(e: Env) -> u32 {
            e.storage().instance().get(&KEY_RES).unwrap_or(300)
        }

        pub fn assets(e: Env) -> Vec<Asset> {
            e.storage()
                .instance()
                .get(&KEY_ASSETS)
                .unwrap_or_else(|| Vec::new(&e))
        }

        pub fn lastprice(e: Env, asset: Asset) -> Option<PriceData> {
            let assets: Vec<Asset> = e
                .storage()
                .instance()
                .get(&KEY_ASSETS)
                .unwrap_or_else(|| Vec::new(&e));
            let prices: Vec<i128> = e
                .storage()
                .instance()
                .get(&KEY_PRICES)
                .unwrap_or_else(|| Vec::new(&e));

            for i in 0..assets.len() {
                if assets.get(i).unwrap() == asset {
                    let price = prices.get(i).unwrap_or(0);
                    return Some(PriceData {
                        price,
                        timestamp: e.ledger().timestamp(),
                    });
                }
            }
            None
        }

        pub fn price(e: Env, asset: Asset, _timestamp: u64) -> Option<PriceData> {
            Self::lastprice(e, asset)
        }

        pub fn prices(e: Env, asset: Asset, _records: u32) -> Option<Vec<PriceData>> {
            let p = Self::lastprice(e.clone(), asset)?;
            let mut v = Vec::new(&e);
            v.push_back(p);
            Some(v)
        }
    }
}

use mock_oracle::{Asset, MockOracleClient};

// ── EnvTestUtils ───────────────────────────────────────────────────────────────

pub trait EnvTestUtils {
    /// Jump the env by `ledgers` ledgers (5 seconds each).
    fn jump(&self, ledgers: u32);
    /// Reset the ledger to a known default: Sept 1 2015, protocol 25, seq 100.
    fn set_default_info(&self);
}

impl EnvTestUtils for Env {
    fn jump(&self, ledgers: u32) {
        self.ledger().set(LedgerInfo {
            timestamp: self.ledger().timestamp().saturating_add(ledgers as u64 * 5),
            protocol_version: 25,
            sequence_number: self.ledger().sequence().saturating_add(ledgers),
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 30 * ONE_DAY_LEDGERS,
            min_persistent_entry_ttl: 30 * ONE_DAY_LEDGERS,
            max_entry_ttl: 365 * ONE_DAY_LEDGERS,
        });
    }

    fn set_default_info(&self) {
        self.ledger().set(LedgerInfo {
            timestamp: 1441065600, // Sept 1st, 2015 12:00:00 AM UTC
            protocol_version: 25,
            sequence_number: 100,
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 30 * ONE_DAY_LEDGERS,
            min_persistent_entry_ttl: 30 * ONE_DAY_LEDGERS,
            max_entry_ttl: 365 * ONE_DAY_LEDGERS,
        });
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

fn create_backstop<'a>(
    e: &Env,
    contract_id: &Address,
    backstop_token: &Address,
    emitter: &Address,
    blnd_token: &Address,
    usdc_token: &Address,
    pool_factory: &Address,
    drop_list: &Vec<(Address, i128)>,
) -> BackstopClient<'a> {
    e.register_at(
        contract_id,
        backstop::WASM,
        (
            backstop_token,
            emitter,
            blnd_token,
            usdc_token,
            pool_factory,
            drop_list.clone(),
        ),
    );
    BackstopClient::new(e, contract_id)
}

fn create_pool_factory<'a>(
    e: &Env,
    contract_id: &Address,
    init: PoolInitMeta,
) -> PoolFactoryClient<'a> {
    e.register_at(contract_id, pool_factory::WASM, (init,));
    PoolFactoryClient::new(e, contract_id)
}

fn create_mock_oracle<'a>(e: &Env) -> (Address, MockOracleClient<'a>) {
    let addr = Address::generate(e);
    e.register_at(&addr, mock_oracle::MockOracle, ());
    (addr.clone(), MockOracleClient::new(e, &addr))
}

// ── BlendFixture ───────────────────────────────────────────────────────────────

/// Holds references to the core Blend protocol contracts after deployment.
pub struct BlendFixture<'a> {
    pub backstop: backstop::Client<'a>,
    pub emitter: emitter::Client<'a>,
    pub pool_factory: pool_factory::Client<'a>,
}

impl<'a> BlendFixture<'a> {
    /// Deploy a complete Blend protocol stack.
    ///
    /// Mints ~2001 × initial amounts of BLND and USDC to `deployer` so that
    /// the Comet backstop LP pool can be fully initialised and joined.
    /// After this call `deployer` holds roughly 1.999 trillion Comet LP tokens
    /// which can be deposited into the backstop for individual pools.
    pub fn deploy(env: &Env, deployer: &Address, blnd: &Address, usdc: &Address) -> Self {
        env.cost_estimate().budget().reset_unlimited();

        let backstop_id = Address::generate(env);
        let pool_factory_id = Address::generate(env);

        // Register core Blend contracts
        let emitter = env.register(emitter::WASM, ());
        let comet = env.register(comet::WASM, ());

        // Mint enough BLND and USDC to the deployer for the Comet LP pool
        let blnd_client = StellarAssetClient::new(env, blnd);
        let usdc_client = StellarAssetClient::new(env, usdc);
        blnd_client.mint(deployer, &(1_000_0000000_i128 * 2001));
        usdc_client.mint(deployer, &(25_0000000_i128 * 2001));

        // Initialise and join the Comet pool (80% BLND / 20% USDC, 0.3% fee)
        let comet_client = comet::Client::new(env, &comet);
        comet_client.init(
            deployer,
            &vec![env, blnd.clone(), usdc.clone()],
            &vec![env, 0_8000000_i128, 0_2000000_i128],
            &vec![env, 1_000_0000000_i128, 25_0000000_i128],
            &0_0030000_i128,
        );
        // join_pool mints ~199_900_0000000 LP tokens on top of the 100 from init
        comet_client.join_pool(
            &199_900_0000000_i128,
            &vec![
                env,
                1_000_0000000_i128 * 2000,
                25_0000000_i128 * 2000,
            ],
            deployer,
        );

        // Transfer BLND admin rights to the emitter
        blnd_client.set_admin(&emitter);
        let emitter_client = emitter::Client::new(env, &emitter);
        emitter_client.initialize(blnd, &backstop_id, &comet);

        let empty: Vec<(Address, i128)> = vec![env];
        let backstop_client = create_backstop(
            env,
            &backstop_id,
            &comet,
            &emitter,
            blnd,
            usdc,
            &pool_factory_id,
            &empty,
        );

        let pool_hash = env.deployer().upload_contract_wasm(pool::WASM);
        let pool_init_meta = PoolInitMeta {
            backstop: backstop_id.clone(),
            pool_hash,
            blnd_id: blnd.clone(),
        };
        let pool_factory_client = create_pool_factory(env, &pool_factory_id, pool_init_meta);

        // Start the first distribution period
        backstop_client.distribute();

        BlendFixture {
            backstop: backstop_client,
            emitter: emitter_client,
            pool_factory: pool_factory_client,
        }
    }
}

// ── create_blend_pool ──────────────────────────────────────────────────────────

/// Deploy a Blend lending pool with USDC and XLM reserves and activate emissions.
///
/// After the call the pool is live and `admin` has deposited backstop tokens so
/// the pool is in the reward zone.  The env ledger is advanced by 7 days to
/// trigger the first emission distribution.
pub fn create_blend_pool(
    e: &Env,
    blend_fixture: &BlendFixture,
    admin: &Address,
    usdc: &StellarAssetClient,
    xlm: &StellarAssetClient,
) -> Address {
    // Give admin enough USDC and XLM to fund the pool reserves
    usdc.mint(admin, &200_000_0000000_i128);
    xlm.mint(admin, &200_000_0000000_i128);

    // Deploy a mock SEP-40 oracle with USDC = $1.00 and XLM = $0.10
    let (oracle, oracle_client) = create_mock_oracle(e);
    oracle_client.set_data(
        admin,
        &Asset::Other(Symbol::new(e, "USD")),
        &vec![
            e,
            Asset::Stellar(usdc.address.clone()),
            Asset::Stellar(xlm.address.clone()),
        ],
        &7_u32,
        &300_u32,
    );
    oracle_client.set_price_stable(&vec![e, 1_000_0000_i128, 100_0000_i128]);

    // Deploy the lending pool via the pool factory
    let salt = BytesN::<32>::random(e);
    let pool = blend_fixture.pool_factory.deploy(
        admin,
        &String::from_str(e, "TEST"),
        &salt,
        &oracle,
        &0_u32,
        &4_u32,
        &1_0000000_i128,
    );

    let pool_client = BlendPoolClient::new(e, &pool);

    // Fund the backstop for this pool (needed to enter reward zone)
    blend_fixture
        .backstop
        .deposit(admin, &pool, &20_0000_0000000_i128);

    // Configure USDC reserve (index 0)
    let reserve_config = ReserveConfig {
        c_factor: 900_0000,
        decimals: 7,
        index: 0,
        l_factor: 900_0000,
        max_util: 900_0000,
        reactivity: 0,
        r_base: 100_0000,
        r_one: 0,
        r_two: 0,
        r_three: 0,
        util: 0,
        supply_cap: 170_141_183_460_469_231_731_687_303_715_884_105_727,
        enabled: true,
    };
    pool_client.queue_set_reserve(&usdc.address, &reserve_config);
    pool_client.set_reserve(&usdc.address);

    // Configure XLM reserve (index 1)
    pool_client.queue_set_reserve(&xlm.address, &reserve_config);
    pool_client.set_reserve(&xlm.address);

    // Set up emission splits: 25% each for supply/borrow on USDC and XLM
    let emission_config = vec![
        e,
        ReserveEmissionMetadata {
            res_index: 0,
            res_type: 0,
            share: 250_0000,
        },
        ReserveEmissionMetadata {
            res_index: 0,
            res_type: 1,
            share: 250_0000,
        },
        ReserveEmissionMetadata {
            res_index: 1,
            res_type: 0,
            share: 250_0000,
        },
        ReserveEmissionMetadata {
            res_index: 1,
            res_type: 1,
            share: 250_0000,
        },
    ];
    pool_client.set_emissions_config(&emission_config);

    // Add pool to the reward zone and open it for deposits
    blend_fixture.backstop.add_reward(&pool, &None);
    pool_client.set_status(&0_u32);

    // Advance 7 days so the emitter can distribute the first week of BLND rewards
    e.jump(ONE_DAY_LEDGERS * 7);
    blend_fixture.emitter.distribute();
    blend_fixture.backstop.distribute();
    pool_client.gulp_emissions();

    pool
}
