# Instructions

1. Install the dependencies:
   ```bash
   yarn
   ```

2. Install the staking miner:
   ```bash
   cargo install --git https://github.com/paritytech/polkadot-staking-miner polkadot-staking-miner
   ```

3. Run the following command to start zombienet:
   ```bash
   yarn run setup
   ```
   
4. The previous command will open a three-tab window, where the right-most one is the command that **is meant to be executed once a new era is reached after a few minutes**.

5. Run the tests:
   ```bash
   yarn test
   ```
