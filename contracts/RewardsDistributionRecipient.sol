// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

abstract contract RewardsDistributionRecipient {
    /// @notice the only address allowed to start epochs on this pool: the factory.
    address public immutable rewardsDistribution;

    constructor(address _rewardsDistribution) {
        rewardsDistribution = _rewardsDistribution;
    }

    function notifyRewardAmount(
        uint256 reward,
        uint256 startTime,
        uint256 rewardsDuration,
        uint256 lockDuration,
        uint256 maxStakingPower
    ) external virtual;

    modifier onlyRewardsDistribution() {
        require(msg.sender == rewardsDistribution, "Caller is not RewardsDistribution contract");
        _;
    }
}
