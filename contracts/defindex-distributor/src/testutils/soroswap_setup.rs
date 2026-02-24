use soroban_sdk::{Address, BytesN, Env};

fn pair_wasm(e: &Env) -> BytesN<32> {
    soroban_sdk::contractimport!(file = "external_wasms/soroswap_pair.wasm");
    e.deployer().upload_contract_wasm(WASM)
}

mod soroswap_factory {
    soroban_sdk::contractimport!(file = "external_wasms/soroswap_factory.wasm");
    pub type SoroswapFactoryClient<'a> = Client<'a>;
}
pub use soroswap_factory::SoroswapFactoryClient;

mod soroswap_router {
    soroban_sdk::contractimport!(file = "external_wasms/soroswap_router.wasm");
    pub type SoroswapRouterClient<'a> = Client<'a>;
}
pub use soroswap_router::SoroswapRouterClient;

pub fn create_soroswap_factory<'a>(e: &Env, setter: &Address) -> SoroswapFactoryClient<'a> {
    let pair_hash = pair_wasm(e);
    let addr = e.register(soroswap_factory::WASM, ());
    let client = SoroswapFactoryClient::new(e, &addr);
    client.initialize(setter, &pair_hash);
    client
}

pub fn create_soroswap_router<'a>(e: &Env, factory: &Address) -> SoroswapRouterClient<'a> {
    let addr = e.register(soroswap_router::WASM, ());
    let client = SoroswapRouterClient::new(e, &addr);
    client.initialize(factory);
    client
}

/// Adds liquidity to a new Soroswap pair. Requires `env.mock_all_auths()` to be active.
pub fn create_soroswap_pool(
    e: &Env,
    router: &SoroswapRouterClient,
    to: &Address,
    token_a: &Address,
    token_b: &Address,
    amount_a: i128,
    amount_b: i128,
) {
    let deadline = e.ledger().timestamp() + 3600;
    router.add_liquidity(
        token_a,
        token_b,
        &amount_a,
        &amount_b,
        &0i128,
        &0i128,
        to,
        &deadline,
    );
}
