#!/usr/bin/env bash
# usage: script/deploy.sh testnet|mainnet
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

case "${1:-}" in
  testnet) RPC=$KUB_TESTNET_RPC; VERIFIER_URL=$KUB_TESTNET_VERIFIER_URL; CHAIN=25925 ;;
  mainnet) RPC=$KUB_MAINNET_RPC; VERIFIER_URL=$KUB_MAINNET_VERIFIER_URL; CHAIN=96 ;;
  *) echo "usage: $0 testnet|mainnet" >&2; exit 1 ;;
esac

: "${PRIVATE_KEY:?}" "${REWARDS_TOKEN:?}" "${STAKING_REWARDS_GENESIS:?}"

forge create contracts/StakingRewardsFactory.sol:StakingRewardsFactory \
  --rpc-url "$RPC" --chain "$CHAIN" --private-key "$PRIVATE_KEY" --broadcast \
  --constructor-args "$REWARDS_TOKEN" "$STAKING_REWARDS_GENESIS" \
  --verify --verifier blockscout --verifier-url "$VERIFIER_URL"
