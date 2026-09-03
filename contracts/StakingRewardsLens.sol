// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "./StakingRewards.sol";
import "./StakingRewardsFactory.sol";
import "./interfaces/IStakingRewards.sol";

/// @title StakingRewardsLens
/// @notice Read-only aggregator: everything a front end needs about a pool, an account, or a
/// whole page of pools, in **one** RPC call.
/// @dev Stateless and permissionless. It holds no funds, has no owner, stores nothing and is
/// never called by {StakingRewards} or {StakingRewardsFactory} - nothing in the protocol depends
/// on it, so it can be redeployed or replaced at any time without touching a live pool.
/// Why it is a separate contract rather than views on the pool itself: the factory embeds the
/// pool's creation code, so every byte added to {StakingRewards} costs the factory a byte too,
/// and the factory was already close to the EIP-170 24 576-byte limit. Keeping the aggregation
/// out here means the read surface can grow freely, and one lens serves every pool and every
/// factory ever deployed. The pattern is the same as Aave's UiPoolDataProvider and PancakeSwap's
/// MasterChef lens contracts.
/// All values are settled to the calling block, and `blockTimestamp` is returned alongside them,
/// so a caller never has to redo the accrual maths or trust its own clock.
contract StakingRewardsLens {
    /// @notice A pool's full state, settled to the current block.
    /// @dev Replaces fifteen individual getters, and the values are mutually consistent because
    /// they come out of one call.
    function poolState(address pool) public view returns (IStakingRewards.PoolView memory p) {
        StakingRewards s = StakingRewards(pool);
        uint256 cap = s.maxStakingPower();
        uint256 supply = s.totalSupply();
        address rewardsToken = address(s.rewardsToken());

        p = IStakingRewards.PoolView({
            stakingToken: address(s.stakingToken()),
            rewardsToken: rewardsToken,
            creator: s.creator(),
            totalSupply: supply,
            maxStakingPower: cap,
            remainingStakingPower: cap == 0 ? type(uint256).max : (cap > supply ? cap - supply : 0),
            rewardRate: s.rewardRate(),
            rewardPerTokenNow: s.rewardPerToken(),
            rewardForDuration: s.getRewardForDuration(),
            unallocatedRewards: s.unallocatedRewards(),
            rewardsBalance: IERC20(rewardsToken).balanceOf(pool),
            startTime: s.startTime(),
            periodFinish: s.periodFinish(),
            lastUpdateTime: s.lastUpdateTime(),
            rewardsDuration: s.rewardsDuration(),
            lockDuration: s.lockDuration(),
            blockTimestamp: block.timestamp,
            closed: s.closed()
        });
    }

    /// @notice One account's full position in a pool.
    /// @dev Includes the account's own staking token balance and the allowance the pool holds,
    /// so a stake form needs no extra token calls. `stakingAllowance` goes through the pool's
    /// KAP-20 fallback, so it is correct for KUSDT and friends, which expose `allowances` rather
    /// than `allowance`.
    function userState(address pool, address account)
        public
        view
        returns (IStakingRewards.UserView memory u)
    {
        StakingRewards s = StakingRewards(pool);
        u = IStakingRewards.UserView({
            balance: s.balanceOf(account),
            earned: s.earned(account),
            withdrawable: s.withdrawableOf(account),
            nextUnlockAt: s.nextUnlockAt(account),
            lotCount: s.totalUserStakedIndex(account),
            liveLots: s.liveLots(account),
            stakingBalance: s.stakingToken().balanceOf(account),
            stakingAllowance: s.stakingAllowance(account)
        });
    }

    /// @notice The one call a pool page needs: the pool, the viewer's position, and a page of
    /// the viewer's deposit lots.
    /// @param account the viewer. Pass the zero address to read the pool alone.
    /// @param lotStart first deposit lot index to return.
    /// @param lotCount how many lots to return. 0 skips them; `type(uint256).max` asks for all.
    function state(address pool, address account, uint256 lotStart, uint256 lotCount)
        external
        view
        returns (
            IStakingRewards.PoolView memory poolView,
            IStakingRewards.UserView memory userView,
            IStakingRewards.Deposit[] memory lots
        )
    {
        poolView = poolState(pool);
        userView = userState(pool, account);
        lots = StakingRewards(pool).getUserInfosPaged(account, lotStart, lotCount);
    }

    /// @notice Many pools and one account's position in each, in a single call.
    /// @dev The call a portfolio or "my pools" page needs. The list is caller-chosen and
    /// unbounded; as an `eth_call` nobody pays for it, but a caller building a very long list
    /// should page it with {statesByFactory} instead.
    function states(address[] calldata pools, address account)
        external
        view
        returns (IStakingRewards.PoolView[] memory poolViews, IStakingRewards.UserView[] memory userViews)
    {
        uint256 len = pools.length;
        poolViews = new IStakingRewards.PoolView[](len);
        userViews = new IStakingRewards.UserView[](len);
        for (uint256 i = 0; i < len;) {
            poolViews[i] = poolState(pools[i]);
            userViews[i] = userState(pools[i], account);
            unchecked {
                ++i;
            }
        }
    }

    /// @notice A page of a factory's pools, with the factory's index entry, the live pool state
    /// and the viewer's position for each - the whole pool list in one call.
    /// @dev `total` is returned so a caller knows how many pages there are without a second
    /// call. A short page near the end is returned rather than reverting.
    /// @param account the viewer. Pass the zero address for the list alone.
    function statesByFactory(
        address factory,
        address account,
        uint256 start,
        uint256 count
    )
        external
        view
        returns (
            uint256 total,
            address[] memory pools,
            StakingRewardsFactory.StakingRewardsInfo[] memory infos,
            IStakingRewards.PoolView[] memory poolViews,
            IStakingRewards.UserView[] memory userViews
        )
    {
        StakingRewardsFactory f = StakingRewardsFactory(factory);
        total = f.poolsLength();
        if (start >= total) {
            return (total, pools, infos, poolViews, userViews);
        }

        uint256 end = start + count;
        if (end > total || end < start) end = total;
        uint256 len = end - start;

        pools = new address[](len);
        infos = new StakingRewardsFactory.StakingRewardsInfo[](len);
        poolViews = new IStakingRewards.PoolView[](len);
        userViews = new IStakingRewards.UserView[](len);

        for (uint256 i = 0; i < len;) {
            address pool = f.pools(start + i);
            pools[i] = pool;
            infos[i] = _info(f, pool);
            poolViews[i] = poolState(pool);
            userViews[i] = userState(pool, account);
            unchecked {
                ++i;
            }
        }
    }

    /// @notice A page of the pools `creator` opened, in the same shape as {statesByFactory}.
    function statesByCreator(
        address factory,
        address creator,
        address account,
        uint256 start,
        uint256 count
    )
        external
        view
        returns (
            uint256 total,
            address[] memory pools,
            StakingRewardsFactory.StakingRewardsInfo[] memory infos,
            IStakingRewards.PoolView[] memory poolViews,
            IStakingRewards.UserView[] memory userViews
        )
    {
        StakingRewardsFactory f = StakingRewardsFactory(factory);
        total = f.poolsByCreatorLength(creator);
        if (start >= total) {
            return (total, pools, infos, poolViews, userViews);
        }

        uint256 end = start + count;
        if (end > total || end < start) end = total;
        uint256 len = end - start;

        pools = new address[](len);
        infos = new StakingRewardsFactory.StakingRewardsInfo[](len);
        poolViews = new IStakingRewards.PoolView[](len);
        userViews = new IStakingRewards.UserView[](len);

        for (uint256 i = 0; i < len;) {
            address pool = f.poolsByCreator(creator, start + i);
            pools[i] = pool;
            infos[i] = _info(f, pool);
            poolViews[i] = poolState(pool);
            userViews[i] = userState(pool, account);
            unchecked {
                ++i;
            }
        }
    }

    /// @dev The factory's generated `poolInfo` getter returns a flat tuple; rebuild the struct.
    function _info(StakingRewardsFactory f, address pool)
        private
        view
        returns (StakingRewardsFactory.StakingRewardsInfo memory info)
    {
        (
            address creator,
            uint40 startTime,
            uint32 rewardsDuration,
            address stakingToken,
            uint32 lockDuration,
            uint32 epoch,
            address rewardsToken,
            uint256 rewardAmount,
            uint128 maxStakingPower
        ) = f.poolInfo(pool);

        info = StakingRewardsFactory.StakingRewardsInfo({
            creator: creator,
            startTime: startTime,
            rewardsDuration: rewardsDuration,
            stakingToken: stakingToken,
            lockDuration: lockDuration,
            epoch: epoch,
            rewardsToken: rewardsToken,
            rewardAmount: rewardAmount,
            maxStakingPower: maxStakingPower
        });
    }
}
