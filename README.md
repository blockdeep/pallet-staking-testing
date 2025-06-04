# Polkadot Staking Integration Tests

This project provides a testing environment for Polkadot staking functionality. It includes:

- A local test network setup using zombienet.
- Integration with polkadot-staking-miner for staking operations.
- Automated test suite for validating staking behavior.

The setup process initializes a local test network and configures the necessary parts for staking operations. The test suite verifies the correct behavior of staking functionality, including validator selection, rewards distribution, and era transitions.

Note: The staking miner requires a new era to be reached before executing certain operations, which typically takes a few minutes after the initial setup.

## Instructions

1. Make sure you get a copy of `polkadot-sdk` and this one:
```bash
$ git clone https://github.com/blockdeep/pallet-staking-integration-tests
$ git clone https://github.com/paritytech/polkadot-sdk.git --depth 1 --branch RFC-0097-port
```

2. Install the dependencies:
   ```bash
   cd pallet-staking-integration-tests
   yarn install
   ```

3. Install the staking miner:
   ```bash
   cargo +nightly install --git https://github.com/paritytech/polkadot-staking-miner polkadot-staking-miner
   ```

4. Bootstrap the network:

#### MacOS:
This will require [iTerm](https://iterm2.com) to be installed. Run the following command to start zombienet:
   ```bash
   yarn run setup
   ```
The previous command will open a three-tab window, where the right-most one is the command that **is meant to be manually executed once a new era is reached after a few minutes**.

#### Linux:

Open three terminals and run the following:
```bash
# Terminal 1: Start zombienet
$ cd ../polkadot-sdk/substrate/frame/staking-async/runtimes/parachain && ./build-and-run-zn.sh

# Terminal 2: Fork the network with chopsticks once at least one era passes on the parachain.
# You will likely have to wait several minutes for that.
$ cd /tmp && npx @acala-network/chopsticks@latest -e ws://127.0.0.1:9966

# Terminal 3. Wait until the parachain on zombienet (terminal 1) starts producing blocks and then execute it.
$ RUST_LOG="polkadot-staking-miner=trace,info" polkadot-staking-miner --uri ws://127.0.0.1:9966 experimental-monitor-multi-block --seed-or-path //Bob
```

5. Run the tests in a separate terminal:
   ```bash
   yarn test
   ```
