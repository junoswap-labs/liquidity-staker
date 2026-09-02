#!/usr/bin/env bash
# usage: script/verify.sh testnet|mainnet <address> [contracts/Path.sol:Name] [abi-encoded-ctor-args]
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

NET=${1:?net}; ADDR=${2:?address}
TARGET=${3:-contracts/StakingRewardsFactory.sol:StakingRewardsFactory}
case "$NET" in
  testnet) VERIFIER_URL=$KUB_TESTNET_VERIFIER_URL; CHAIN=25925 ;;
  mainnet) VERIFIER_URL=$KUB_MAINNET_VERIFIER_URL; CHAIN=96 ;;
  *) echo "usage: $0 testnet|mainnet <address> [target] [ctor-args]" >&2; exit 1 ;;
esac

ARGS=${4:-$(cast abi-encode "c(address,uint256)" "$REWARDS_TOKEN" "$STAKING_REWARDS_GENESIS")}

forge verify-contract "$ADDR" "$TARGET" \
  --chain "$CHAIN" --verifier blockscout --verifier-url "$VERIFIER_URL" \
  --constructor-args "$ARGS" --watch
