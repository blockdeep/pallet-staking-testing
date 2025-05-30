# Instructions

1. Install the dependencies:
   ```bash
   yarn install
   ```

2. Install the staking miner:
   ```bash
   cargo +nightly install --git https://github.com/paritytech/polkadot-staking-miner polkadot-staking-miner
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

# Description

This project provides a testing environment for Polkadot staking functionality. It includes:

- A local test network setup using zombienet.
- Integration with polkadot-staking-miner for staking operations.
- Automated test suite for validating staking behavior.

The setup process initializes a local test network and configures the necessary parts for staking operations. The
test suite verifies the correct behavior of staking functionality, including validator selection, rewards distribution,
and era transitions.

Note: The staking miner requires a new era to be reached before executing certain operations, which typically takes a
few minutes after the initial setup.
