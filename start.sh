#!/bin/bash

set -e

# Start zombienet
cd ../polkadot-sdk/substrate/frame/staking-async/runtimes/parachain
./build-and-run-zn.sh
