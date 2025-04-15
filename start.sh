#!/bin/bash

set -e

if [ ! -f .bin/substrate-node ]; then
  script_dir=$(dirname "$0")
  bin_folder="$script_dir/.bin"
  mkdir -p "$bin_folder"
  temp_dir=$(mktemp -d)
  git clone --depth 1 --branch "RFC-0097-testing" "https://github.com/blockdeep/polkadot-sdk.git" "$temp_dir"
  cd "$temp_dir"
  cargo build --release -p staging-node-cli
  cp target/release/substrate-node "$bin_folder"
  cd -
  rm -rf "$temp_dir"
fi

.bin/substrate-node --dev

# Now just run "npm test"

