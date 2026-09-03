// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

interface IStakingRewards {
    /// @notice one stake, with its own lock. Packs into a single storage slot.
    struct Deposit {
        uint128 amount; // what is left of this lot
        uint40 stakedAt;
        uint40 unlockAt;
    }

    /// @notice everything about a pool, so a front end never needs a second round trip.
    /// @dev Returned by {StakingRewards.poolState}. `rewardPerTokenNow` and `rewardForDuration`
    /// are settled to `blockTimestamp`, so a caller does not have to redo the accrual maths, and
    /// `blockTimestamp` is included so it does not have to trust its own clock either.
    struct PoolView {
        address stakingToken;
        address rewardsToken;
        address creator;
        uint256 totalSupply;
        uint256 maxStakingPower; // 0 = uncapped
        uint256 remainingStakingPower;
        uint256 rewardRate; // per second, scaled by PRECISION
        uint256 rewardPerTokenNow; // accumulator settled to now, scaled by PRECISION
        uint256 rewardForDuration; // total budget of the running epoch
        uint256 unallocatedRewards;
        uint256 rewardsBalance; // rewardsToken held by the pool
        uint256 startTime;
        uint256 periodFinish;
        uint256 lastUpdateTime;
        uint256 rewardsDuration;
        uint256 lockDuration;
        uint256 blockTimestamp;
        bool closed;
    }

    /// @notice everything about one account's position in a pool.
    /// @dev Returned by {StakingRewards.userState}. `stakingBalance` and `stakingAllowance` are
    /// the two token reads a stake form needs, so the form is covered by the same call.
    struct UserView {
        uint256 balance;
        uint256 earned;
        uint256 withdrawable; // unlocked right now
        uint256 nextUnlockAt; // 0 when nothing is locked
        uint256 lotCount; // every lot ever opened, drained ones included
        uint256 liveLots; // against MAX_LIVE_LOTS
        uint256 stakingBalance; // account's stakingToken balance
        uint256 stakingAllowance; // what the pool may pull from the account
    }

    // Views
    function lastTimeRewardApplicable() external view returns (uint256);

    function rewardPerToken() external view returns (uint256);

    function earned(address account) external view returns (uint256);

    function getRewardForDuration() external view returns (uint256);

    function totalSupply() external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    // cap on the total staked, 0 when unlimited, and what is left of it
    function maxStakingPower() external view returns (uint128);

    function remainingStakingPower() external view returns (uint256);

    // deposit lots: every stake is its own lot with its own unlock time
    function totalUserStakedIndex(address user) external view returns (uint256);

    function getUserInfoByIndex(address user, uint256 index) external view returns (Deposit memory);

    function getUserInfos(address user) external view returns (Deposit[] memory);

    function getUserInfosPaged(address user, uint256 start, uint256 count) external view returns (Deposit[] memory);

    function withdrawableOf(address user) external view returns (uint256);

    function nextUnlockAt(address user) external view returns (uint256);

    function liveLots(address user) external view returns (uint256);

    // Mutative

    function stake(uint256 amount) external;

    function withdraw(uint256 amount) external;

    // withdraw from one lot by index, in constant gas
    function withdrawFrom(uint256 index, uint256 amount) external;

    function getReward() external;

    // pays `account` rather than the caller, so rewards can be harvested in batch
    function getRewardFor(address account) external;

    // turnover: rewards that accrued while nobody was staked, claimable by the pool
    // creator once the pool is closed
    function unallocatedRewards() external view returns (uint256);

    function recoverUnallocatedRewards() external returns (uint256);

    // retire the pool: no further epochs, and the creator may recover what nobody could earn
    function close() external;

    function closed() external view returns (bool);

    function exit() external;
}
