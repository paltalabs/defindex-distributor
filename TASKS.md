# Tasks — DeFindex Distribution

## Milestone 0: Soroban Setup

- [ ] Create hello world smart contract in contracts folder
- [ ] Create scripts or instructions to deploy
- [ ] User should be able to see the address of deployed contract

## Milestone 1: Micro Distributor Contract only Sender

The first version of the distributor contract will only send the assets to the users, it wont interact with defindex

- [ ] create micro mvp contract
  - [ ] contract should receive an array of:
        [(vault, asset, user, amount), (vault, asset, user, amount), (vault, asset, user, amount)]
  - [ ] contract should return:
        [(vault, asset, user, amount, df_tokens_minted), (vault, asset, user, amount, df_tokens_minted)]
- [ ] add simple test that we receive expected response
- [ ] deploy

## Milestone 2: Script should work with micro mvp contract

- [x] script should take address of distributor contract
- [x] script should take csv and execute batch of transactions
- [x] script should work with distributor contract

## Milestone 3: Add Defindex interactions

- [ ] add defindex wasms in distributor project
- [ ] make distributor contract do deposit, take df tokens minted, compare with underlying asset and fail if user didnt receive the correct amount
- [ ] add tests that will check that the user underlying balance delta is the corresponding amount, for every user, and that the minted dftokens is the same as returned by contract and is the same as the dftoken balance delta of the user.

## Milestone 4: Add events

events should return more info like underlying assets of minted tokens.

## Milestone 5: Distribute script logs

- when executing distribute, we should also check for every user, that the minted dftokens is the same as the returned by contract execution and is the same as the dfToken delta (before and after execution)
- [x] Check dfTokens for every user before transaction call
- [x] Check dfTokens for every user after transaction call
- [x] Display dfTokens before, after, delta, transaction result, transaction hash, distrubution delta

## Milestone 6: Execution script refinement

- [x] Update scripts to work with new .env config
- [z] Create logger service:
      - Should create a timestamp named .log and .csv file
      - Sould update line by line so in case of failure we get all the executed info
- [x] Update demo script to create defindex vaults with blend strategies on testnet:
      - [ ] get strategies from [defindex repo](https://raw.githubusercontent.com/paltalabs/defindex/refs/heads/main/public/testnet.contracts.json)
      - [ ] we should deposit and rebalance (can use [defindex api](https://api.defindex.io/docs#tag/Factory/operation/FactoryController_createVaultAutoInvest))
      - [ ] Based on the created data determine if mint is needed, if its, auto run mint
- [x] Update mint script:
      - [ ] support xlm (we can create random keypairs, fund, transfer 98.5% of funds to manager)
- [x] Update docs:
      - Add prerequisites
      - Review ortography and sintaxis errors
