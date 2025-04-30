# Instructions

1. Install the dependencies:
   ```bash
   npm install
   ```

2. Install the staking miner:
   ```bash
   cargo install --git https://github.com/paritytech/polkadot-staking-miner polkadot-staking-miner
   ```

3. Run the following command to start zombienet:
   ```bash
   ./start.sh
   ```
   
4. Start the staking miner:
   ```bash
   RUST_LOG="polkadot-staking-miner=trace,info" ./target/release/polkadot-staking-miner --uri ws://127.0.0.1:9966 experimental-monitor-multi-block --seed-or-path //Bob
   ```

5. Wait a few minutes until a new era is reached and with it an election is performed.

6. Run chopsticks to fork the network and be able to run the tests several times.
   ```bash
   npx @acala-network/chopsticks@latest -e ws://127.0.0.1:9966
   ```

7. Run the tests:
   ```bash
   npm test
   ```
