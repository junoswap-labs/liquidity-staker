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

: "${PRIVATE_KEY:?}"

deploy() {
  forge create "$1" \
    --rpc-url "$RPC" --chain "$CHAIN" --private-key "$PRIVATE_KEY" --broadcast \
    --verify --verifier blockscout --verifier-url "$VERIFIER_URL"
}

# the factory: the only contract the protocol depends on
deploy contracts/StakingRewardsFactory.sol:StakingRewardsFactory

# the lens: read-only aggregator for front ends. Holds nothing, is never called by the
# factory or a pool, and can be redeployed or replaced without touching a live pool.
deploy contracts/StakingRewardsLens.sol:StakingRewardsLens
