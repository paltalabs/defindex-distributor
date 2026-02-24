#![no_std]
use soroban_sdk::{contract, contractimpl, vec, Address, Env, Vec};

#[contract]
pub struct Distributor;

#[contractimpl]
impl Distributor {
    pub fn distribute(
        e: Env,
        caller: Address,
        vault: Address,
        token: Address,
        recipients: Vec<(Address, i128)>,
    ) -> Vec<(Address, i128)> {
        caller.require_auth();
        e.storage().instance().extend_ttl(17280, 17280 * 7);

        // TODO: sum all amounts
        // let mut total: i128 = 0;
        // for (_, amount) in recipients.iter() {
        //     total += amount;
        // }

        // TODO: pull total from caller into this contract
        // let token_client = TokenClient::new(&e, &token);
        // token_client.transfer(&caller, &e.current_contract_address(), &total);

        // TODO: deposit into defindex vault, receive df tokens
        // let vault_client = VaultClient::new(&e, &vault);
        // vault_client.deposit(&total, &e.current_contract_address());

        // TODO: distribute df tokens to each recipient
        // for (user, amount) in recipients.iter() {
        //     df_token_client.transfer(&e.current_contract_address(), &user, &df_amount);
        // }

        let _ = (&vault, &token);

        // Mock: return (user, df_tokens_minted) using the input amount as a stand-in
        let mut results: Vec<(Address, i128)> = vec![&e];
        for (user, amount) in recipients.iter() {
            results.push_back((user, amount));
        }
        results
    }
}

mod test;
