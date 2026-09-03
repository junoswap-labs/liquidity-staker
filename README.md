# liquidity-staker

Permissionless staking pool factory for **KUB Chain**.

Anyone opens a pool: pick the staking token, the reward token, the budget, when it starts,
how long it runs and how long stakes are locked. Fund it up front and it runs itself.

## Fork lineage

This is a fork for the base contracts, not a drop in copy. Synthetix's reward accounting is
well understood and has held up in production for years, so it is the foundation; everything
around it has been reworked for what this protocol needs on KUB Chain. Where behaviour differs
from upstream it is deliberate, and the reason is written in the contract as a `@dev` note.

| | |
|---|---|
| Origin | [Synthetix `StakingRewards`](https://github.com/Synthetixio/synthetix/tree/v2.27.2/) (v2.27.2) |
| Fork | [Uniswap `liquidity-staker`](https://github.com/Uniswap/liquidity-staker) — added `StakingRewardsFactory` and `stakeWithPermit` |
| This repo | Uniswap fork, reworked for this protocol on KUB Chain: Solidity 0.8, permissionless pools, per epoch reward token / schedule / lock / staking cap, service fee, batch claim, turnover recovery, KAP-20 support, precision fix, gas work |

Reward accounting is unchanged in shape from Synthetix: the O(1) accrual accumulator.
`rewardPerTokenStored` / `userRewardPerTokenPaid` are the same maths as MasterChef's
`accRewardPerShare` / `rewardDebt` (PancakeSwap), scaled by `1e36` instead of `1e12`.

## What it supports

**Pool configuration**, all chosen per pool by whoever opens it:

| Parameter | Meaning |
|---|---|
| `stakingToken` | what users stake. Any ERC20 or KAP-20, LP tokens included |
| `rewardsToken` | what they earn. Different per pool — the factory is not tied to one token |
| `rewardAmount` | total budget for the whole period, **not** a per second rate |
| `startTime` | when rewards begin accruing. `0` = the moment the pool is started |
| `rewardsDuration` | how long the epoch runs, in seconds. **At most 1 year** |
| `lockDuration` | how long a stake is locked before withdrawal, in seconds. `0` = no lock. Independent of the epoch length, but never longer than it |
| `maxStakingPower` | cap on the total staked in the pool. `0` = unlimited |

`startTime`, `rewardsDuration`, `lockDuration` and `maxStakingPower` are re-chosen for **every
epoch**; the staking token, reward token and creator are fixed for the life of the pool.

**Everything is timestamp based, never block based.** KUB block times may change
(5s → 3s → 1s) and pools that already exist must not shift when they do.

**KAP-20 / KUB specifics**
- All token movements go through `SafeERC20`, so KAP-20 tokens that differ from strict ERC20 work.
- `StakingRewards.stakingAllowance(account)` reads the ERC20 `allowance` getter and falls back
  to the KAP-20 `allowances` getter. KUSDT has **no** `allowance(address,address)` at all —
  verified on mainnet `0x7d984C24d2499D840eB3b7016077164e15E5faA6`.
- `rewardRate` and `rewardPerTokenStored` are scaled by `PRECISION = 1e36` and every step goes
  through `Math.mulDiv`. `1e18` was not enough: the accumulator also divides by the total
  stake, and since anyone may force a settlement with `getRewardFor`, a 6 decimal reward token
  (KUSDT) over a large pool could be ground down to zero emissions one block at a time. See
  `audit/report.html`, finding C-01. Dust is now a few wei instead of the whole budget.

**Features on top of the Uniswap fork**
- **Permissionless** — no owner approval to open a pool, no allow list. A staking token can
  host as many pools as people care to fund.
- **Self funded pools** — rewards go straight from the creator to the new pool. The factory
  holds no balance, so no pool can ever spend another pool's rewards.
- **Lock period, per deposit** — every `stake` opens its own lot with its own unlock time, so a
  later deposit never re-locks an earlier one. `withdraw(amount)` drains unlocked lots oldest
  first; `withdrawFrom(index, amount)` takes one lot directly, in constant gas. Read them with
  `totalUserStakedIndex` / `getUserInfoByIndex` / `getUserInfos`, and `withdrawableOf(account)`
  for the unlocked total. An account holds at most `MAX_LIVE_LOTS = 256` live lots, which is
  what keeps the withdrawal loop bounded. Claiming rewards is never locked.
- **Scheduled start** — fund and start a pool now, have it begin distributing later.
- **Epochs** — when an epoch ends the creator funds the next one on the same pool with
  `factory.startEpoch(pool, amount, startAt, duration, lock, cap)`, each epoch picking its own
  budget, schedule, lock and cap. Stakers never unstake and restake, and rewards earned in earlier
  epochs are untouched. A live epoch can never be re-rated: the next one may only be opened
  after the current one has ended.
- **Lock capped at the epoch end** — a stake made late in an epoch unlocks at the epoch end, not
  a full `lockDuration` later, so nobody is ever locked past the rewards they staked for.
- **Retire** — `pool.close()` (creator, between epochs) ends the pool for good: no further
  epochs, and it is what unlocks turnover recovery. Withdrawing and claiming stay open forever.
- **Batch claim** — `factory.claimAll([pool, ...])` harvests several pools in one transaction.
- **One RPC reads** — `StakingRewardsLens` returns a pool, a position, a page of deposit lots, or
  a whole page of the factory's pools, in a single call. See below.
- **One settle per transaction** — `stake`, `withdraw`, `withdrawFrom`, `getReward` and `exit`
  each advance the reward accumulator exactly once and walk the deposit lots at most once.
  `exit()` in particular does the work itself instead of calling `withdraw` then `getReward`,
  which would have settled twice, taken the reentrancy guard twice and walked the lots twice.
  Rewards always go to `msg.sender`; nobody can redirect someone else's payout.
- **Turnover recovery** — rewards that accrue while a pool sits empty are unearnable. Once the
  creator has closed the pool they call `pool.recoverUnallocatedRewards()` and get exactly that
  slice back. While another epoch is still possible the leftovers stay in the pool. Stakers'
  earned rewards and staked principal are never in scope.
- **Service fee** — optional fee per pool creation (`feeToken`, `feeAmount`, `feeReceiver`),
  paid straight to the receiver. **Currently off** (`feeAmount = 0`). The owner can only change
  the fee; it cannot touch pools, rewards or stakers.
- **On chain index** — `pools`, `poolsByCreator`, `poolInfo` (creator, both tokens, amount,
  start, duration, lock, current epoch) plus `Deployed` and `EpochStarted` events.

**Not supported, by design**
- Fee on transfer and rebasing tokens as the reward token.
- Adding rewards to a live epoch, or re-rating one that is already running. Top ups happen
  between epochs, never under the stakers who joined the current one.
- An emergency exit that skips the lock.
- Native KUB as the staking, reward or fee token — tokens only.

## Contracts

| File | |
|---|---|
| [`StakingRewardsFactory.sol`](contracts/StakingRewardsFactory.sol) | opens and starts pools, holds the index, charges the optional fee, funds later epochs, batch claims |
| [`StakingRewards.sol`](contracts/StakingRewards.sol) | one pool: staking, rewards, lock, recovery |
| [`libraries/KAP20.sol`](contracts/libraries/KAP20.sol) | allowance read with KAP-20 fallback |

## Usage

```solidity
// 1. approve the factory for the reward budget (+ the fee, if one is set)
rewardsToken.approve(factory, rewardAmount);

// 2. open the pool
address pool = factory.deploy(
    stakingToken,
    rewardsToken,
    rewardAmount,     // total for the epoch
    startTime,        // 0 = start on notify
    rewardsDuration,  // seconds, max 1 year
    lockDuration,     // seconds, 0 = no lock, never longer than the epoch
    maxStakingPower   // 0 = uncapped
);

// deploy already funded and started epoch 1. nothing else to call.

// 3. later, after the epoch has ended: fund the next one, on its own schedule
factory.startEpoch(pool, rewardAmount, startAt, rewardsDuration, lockDuration, maxStakingPower);

// or retire the pool and take back what nobody could earn
pool.close();
pool.recoverUnallocatedRewards();
```

Stakers use `pool.stake` / `withdraw` / `withdrawFrom` / `getReward` / `exit`, or
`factory.claimAll([...])` across pools.

### Reading a pool in one RPC call

`StakingRewardsLens` is a read-only aggregator. It stores nothing, owns nothing, and is never
called by the factory or by a pool, so it can be redeployed or replaced at any time without
touching anything live. Everything it returns is settled to the calling block and comes with
`blockTimestamp`, so a front end never redoes the accrual maths or trusts its own clock.

| Call | Returns |
|---|---|
| `lens.poolState(pool)` | the pool: both tokens, creator, total staked, cap and headroom, rate, accumulator, epoch budget, rewards balance, the whole schedule, `closed` |
| `lens.userState(pool, account)` | the position: balance, earned, withdrawable now, next unlock, lot counts, plus the account's own staking balance and the allowance the pool holds |
| `lens.state(pool, account, lotStart, lotCount)` | **the one call a pool page needs** — pool + position + a page of deposit lots |
| `lens.states([pool, ...], account)` | many pools and the viewer's position in each |
| `lens.statesByFactory(factory, account, start, count)` | a page of every pool the factory made, with its index entry, live state and the viewer's position, plus `total` so no second call is needed |
| `lens.statesByCreator(factory, creator, account, start, count)` | the same, for one creator's pools |

Pass the zero address as `account` to read the pool side alone, and `lotCount` 0 to skip the
lots. A page past the end comes back short rather than reverting.

The aggregation lives in the lens rather than on the pool because the factory embeds the pool's
creation code: every byte added to `StakingRewards` costs the factory a byte too, and the factory
is already near the EIP-170 24 576-byte limit. Same pattern as Aave's `UiPoolDataProvider` and
PancakeSwap's MasterChef lens.

A stake is credited by the balance the pool actually received, not by the amount requested, so
a fee-on-transfer staking token stays solvent rather than promising more than the pool holds.

## Audit

`audit/report.html` (source: `audit/findings.json`) is a self-review of this code against the
`smartcontract-audit` catalogs. One Critical, two High, three Medium, three Low and three
Informational findings; all but two are fixed, each with a regression test in
`test/Regressions.spec.ts`. The two left open are acknowledged rather than fixed:

- **H-03 — KAP-20 committees.** A KAP-20's committee can `adminTransfer` a pool's balance or turn
  on KYC-only transfers, which a contract cannot satisfy. That is inherent to a permissionless
  factory over arbitrary tokens, and **accepted rather than mitigated in code**. A token allowlist
  was written and then deliberately removed: it would have handed the factory owner a veto over
  who may open a pool — the exact permission this factory exists to not have — while removing none
  of the risk, since a listed token's committee keeps every one of those powers after listing.
  Token risk is disclosed by the front end instead.
- **I-01 — gas and layout.** Addressed as far as it goes. The optimizer runs at 1 000, not
  999 999: the factory embeds the pool's initcode, and at the higher setting its runtime reached
  25 719 bytes, past the EIP-170 limit of 24 576 — undeployable. The factory's index struct is
  packed into five slots instead of nine, saving four cold `SSTORE`s on every `deploy` and every
  `startEpoch`, with every narrowed field bounded by an explicit `require` first. The accumulator
  and withdrawal paths were de-duplicated (see the reuse notes above).

### Can `withdraw` ever revert?

Asked directly, and tested rather than assumed (`test/WithdrawLiveness.spec.ts`).

**Nothing inside the pool can block it.** Not the creator, not the factory owner, not a closed
pool, not an ended epoch, not a full deposit-lot array, and not a broken reward token —
`withdraw` never touches `rewardsToken`, and `notifyRewardAmount` bounds the accumulator so the
accrual settle cannot revert either. A locked lot never blocks an unlocked one behind it, and
asking for more than is unlocked is a refusal, not a freeze.

That last property was not free. Finding H-04 in the report: the accumulator had no upper bound,
and overflowing it made `updateReward` revert on **every** path, including withdrawal —
stakers' principal frozen permanently, no override, no recovery. Reproduced with a 2e41 budget
accruing against a 1 wei stake, then closed by checking an epoch's worst-case growth at the
moment it is configured.

**Two things outside the pool still can**, and no code here can prevent either:

- The staking token. Paused, blacklisting the pool, switched to KYC-only transfers (a contract
  cannot be KYC'd), or drained by `adminTransfer` — any of these freezes withdrawals for as long
  as it lasts. This is H-03, disclosed rather than mitigated.
- A staking token that starts charging the **sender** a fee on top of the amount. Inbound fees
  are handled (the pool credits what it received); an outbound fee charged on top is not, because
  the pool holds exactly what it owes. The last withdrawal is then short. Out of scope by design.

A front end should offer `withdraw` and `getReward` as separate actions, not only `exit` — a
broken reward token stops `exit` but never `withdraw` (I-05).

This is a self-audit, not a third-party one. It is a starting point for a real engagement, not a
substitute for it.

## Development

```bash
npm install
npx waffle && npx mocha   # tests: precision sweep over 0/2/6/8/18 decimals, audit regressions
forge build               # foundry, same sources
```

Deploy to KUB Chain — fill in [`.env`](.env.example) first:

```bash
script/deploy.sh testnet   # or mainnet, verifies on kubscan
script/verify.sh testnet <address>
```

| Network | Chain ID | RPC |
|---|---|---|
| KUB testnet | 25925 | `https://rpc-testnet.bitkubchain.io` |
| KUB mainnet | 96 | `https://rpc.bitkubchain.io` |

Solidity 0.8.19 (`evm_version = istanbul`, no PUSH0), OpenZeppelin 4.9.6.
