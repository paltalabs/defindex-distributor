#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, vec, Address, Env, Vec};

#[test]
fn test_distribute_returns_user_and_mocked_df_tokens() {
    let env = Env::default();
    env.mock_all_auths();

    let caller     = Address::generate(&env);
    let vault      = Address::generate(&env);
    let token      = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let distributor_id = env.register(Distributor, ());
    let client = DistributorClient::new(&env, &distributor_id);

    let recipients: Vec<(Address, i128)> = vec![
        &env,
        (recipient1.clone(), 300_i128),
        (recipient2.clone(), 700_i128),
    ];

    let results = client.distribute(&caller, &vault, &token, &recipients);

    // Should return one entry per recipient
    assert_eq!(results.len(), 2);

    // Each entry should be (user, df_tokens_minted) — mocked as the same input amount
    assert_eq!(results.get(0).unwrap(), (recipient1.clone(), 300_i128));
    assert_eq!(results.get(1).unwrap(), (recipient2.clone(), 700_i128));
}

#[test]
fn test_distribute_preserves_order() {
    let env = Env::default();
    env.mock_all_auths();

    let caller = Address::generate(&env);
    let vault  = Address::generate(&env);
    let token  = Address::generate(&env);

    let users: Vec<Address> = vec![
        &env,
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];

    let distributor_id = env.register(Distributor, ());
    let client = DistributorClient::new(&env, &distributor_id);

    let recipients: Vec<(Address, i128)> = vec![
        &env,
        (users.get(0).unwrap(), 100_i128),
        (users.get(1).unwrap(), 200_i128),
        (users.get(2).unwrap(), 300_i128),
    ];

    let results = client.distribute(&caller, &vault, &token, &recipients);

    assert_eq!(results.len(), 3);
    for i in 0..3 {
        let (addr, amount) = results.get(i).unwrap();
        let (expected_addr, expected_amount) = recipients.get(i).unwrap();
        assert_eq!(addr,   expected_addr);
        assert_eq!(amount, expected_amount);
    }
}

#[test]
fn test_distribute_single_recipient() {
    let env = Env::default();
    env.mock_all_auths();

    let caller    = Address::generate(&env);
    let vault     = Address::generate(&env);
    let token     = Address::generate(&env);
    let recipient = Address::generate(&env);

    let distributor_id = env.register(Distributor, ());
    let client = DistributorClient::new(&env, &distributor_id);

    let recipients: Vec<(Address, i128)> = vec![
        &env,
        (recipient.clone(), 500_i128),
    ];

    let results = client.distribute(&caller, &vault, &token, &recipients);

    assert_eq!(results.len(), 1);
    assert_eq!(results.get(0).unwrap(), (recipient, 500_i128));
}
