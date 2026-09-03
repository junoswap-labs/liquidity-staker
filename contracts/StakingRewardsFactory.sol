// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "./StakingRewards.sol";

/// @title StakingRewardsFactory
/// @notice Permissionless factory for staking pools on KUB Chain. Anyone may open a pool by
/// calling {deploy}; there is no allow list and no owner approval. The caller picks the
/// staking token, the reward token, the reward budget, when the pool starts, how long it runs,
/// how long stakes are locked and how much may be staked in total, and funds the rewards up
/// front. When an epoch ends the creator funds the next one on the same pool.
/// @dev Each pool is its own {StakingRewards} contract holding its own rewards, so one pool
/// can never spend another pool's balance. The factory is designed to hold no funds: rewards
/// go straight from the caller to the pool and the optional service fee goes straight to the
/// fee receiver. The only owner power is {setServiceFee}; the owner cannot touch a pool, its
/// rewards or its stakers.
/// All durations are in seconds, never blocks, because KUB block times may change
/// (5s -> 3s -> 1s) and existing pools must not shift when they do.
/// @dev A pool is only ever as safe as the two tokens its creator chose. On KUB a KAP-20's
/// committee can `adminTransfer` any holder's balance, including a pool's, and can switch the
/// token to KYC-only transfers, which a contract cannot satisfy - that would freeze every
/// withdrawal. Neither is reachable from this code, and neither is something this factory can
/// prevent. There is deliberately **no token allowlist**: it would have handed the owner a veto
/// over who may open a pool - the exact permission this factory exists to not have - in exchange
/// for a risk it cannot actually remove, since a listed token's committee keeps every one of
/// those powers after listing. Token risk is disclosed by the front end instead. See audit H-03.
contract StakingRewardsFactory is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Service fee charged per pool creation. Off while feeAmount is 0, which is how it ships.
    /// @notice token the pool creation fee is charged in. Meaningless while feeAmount is 0.
    address public feeToken;
    /// @notice fee charged per {deploy}. Zero, and therefore off, as deployed.
    uint256 public feeAmount;
    /// @notice address the fee is paid to directly. The factory never custodies the fee.
    address public feeReceiver;

    /// @notice every pool ever deployed by this factory, in creation order.
    address[] public pools;

    /// @dev Packed into five slots rather than nine. Every field is bounded by a check the pool
    /// itself enforces - durations by MAX_DURATION (one year, so uint32 is ~136 times the room
    /// needed), startTime by `now + MAX_DURATION` (uint40 lasts to the year 36 812) and
    /// maxStakingPower by uint128 - so the narrower types can never truncate a value the pool
    /// would have accepted. Written once per epoch by {deploy} and {startEpoch}, which is four
    /// fewer cold SSTOREs each; read off chain.
    struct StakingRewardsInfo {
        // slot 0
        address creator;
        uint40 startTime;
        uint32 rewardsDuration; // of the running epoch
        // slot 1
        address stakingToken;
        uint32 lockDuration; // of the running epoch
        uint32 epoch; // 1 from creation, since deploy starts the first epoch
        // slot 2
        address rewardsToken;
        // slot 3
        uint256 rewardAmount; // of the running epoch. A total, not a per second rate
        // slot 4
        uint128 maxStakingPower; // of the running epoch
    }

    /// @notice pool parameters of the epoch currently running, keyed by the pool address.
    /// @dev Refreshed by {startEpoch}, so it never disagrees with the pool itself.
    mapping(address => StakingRewardsInfo) public poolInfo;

    /// @notice pools opened by each address, in creation order.
    mapping(address => address[]) public poolsByCreator;

    event ServiceFeeChanged(address feeToken, uint256 feeAmount, address feeReceiver);

    event Deployed(
        address indexed stakingToken,
        address indexed rewardsToken,
        address indexed stakingRewards,
        address deployer,
        uint256 rewardAmount,
        uint256 startTime,
        uint256 rewardsDuration,
        uint256 lockDuration,
        uint256 maxStakingPower
    );

    event EpochStarted(
        address indexed stakingRewards,
        uint256 indexed epoch,
        uint256 rewardAmount,
        uint256 startTime,
        uint256 rewardsDuration,
        uint256 lockDuration,
        uint256 maxStakingPower
    );

    /// @dev Nothing to configure: pools carry their own schedule and the service fee is off
    /// until the owner turns it on. The owner has no other power.
    constructor() {}

    /// @dev The fee role is needed for the life of the factory, and losing it would freeze the
    /// fee at whatever it happens to be - including a value that makes {deploy} revert. Ownable2Step
    /// covers the mistyped-transfer case; this covers the renounce case.
    function renounceOwnership() public view override onlyOwner {
        revert("StakingRewardsFactory: ownership cannot be renounced");
    }

    /// @notice Owner sets the fee charged for opening a pool. Pass _feeAmount = 0 to turn the
    /// fee off again. Changing it never affects pools that already exist.
    /// @dev Reverts on a fee that could not be collected (non zero amount with a zero token or
    /// receiver). A fee raised between a user's approval and their transaction only makes their
    /// {deploy} revert; it can never take more than they approved.
    function setServiceFee(address _feeToken, uint256 _feeAmount, address _feeReceiver) external onlyOwner {
        require(
            _feeAmount == 0 || (_feeToken != address(0) && _feeReceiver != address(0)),
            "StakingRewardsFactory: incomplete fee"
        );

        feeToken = _feeToken;
        feeAmount = _feeAmount;
        feeReceiver = _feeReceiver;
        emit ServiceFeeChanged(_feeToken, _feeAmount, _feeReceiver);
    }

    /// @notice number of pools ever created, for iterating {pools} off chain.
    function poolsLength() external view returns (uint256) {
        return pools.length;
    }

    /// @notice number of pools opened by `creator`, for iterating {poolsByCreator} off chain.
    function poolsByCreatorLength(address creator) external view returns (uint256) {
        return poolsByCreator[creator].length;
    }

    /// @notice Open a new staking pool and start its first epoch in the same transaction.
    /// Permissionless: no owner approval, no allow list, and a staking token may host as many
    /// pools as people care to fund.
    /// @dev The caller must have approved this factory for `rewardAmount` of `rewardsToken`,
    /// plus {feeAmount} of {feeToken} when the service fee is on. Both transfers leave the
    /// factory in the same transaction, which is why it holds no balance worth attacking.
    /// Notes:
    /// - `rewardAmount` is recorded as requested. A fee on transfer or rebasing reward token
    ///   delivers less than that, and the pool's own balance check in
    ///   {StakingRewards.notifyRewardAmount} then makes the start revert. Such tokens are out
    ///   of scope by design rather than silently under funded.
    /// - all state is written before the external token calls, and every pool is a fresh
    ///   contract, so a reentrant reward token cannot corrupt an existing pool's accounting.
    /// - `stakingToken` is not validated. A pool over a worthless or malicious staking token
    ///   only ever risks its own creator's rewards; the UI is responsible for filtering.
    /// @param stakingToken token users stake. Any ERC20 or KAP-20.
    /// @param rewardsToken token paid out as rewards. May differ per pool.
    /// @param rewardAmount total rewards for the first epoch, not a per second rate.
    /// @param startTime timestamp rewards begin accruing; 0 or past means immediately. The
    /// epoch is live from this call either way, so a pool can never sit funded but unstarted.
    /// @param rewardsDuration length of the first epoch in seconds, at most one year.
    /// @param lockDuration seconds a stake is locked before it can be withdrawn. 0 disables.
    /// @param maxStakingPower cap on the total staked in the pool. 0 means unlimited.
    /// @return stakingRewards address of the newly deployed pool.
    function deploy(
        address stakingToken,
        address rewardsToken,
        uint256 rewardAmount,
        uint256 startTime,
        uint256 rewardsDuration,
        uint256 lockDuration,
        uint256 maxStakingPower
    ) public nonReentrant returns (address stakingRewards) {
        require(rewardsToken != address(0), "StakingRewardsFactory: rewards token is zero");
        require(rewardAmount > 0, "StakingRewardsFactory: reward amount is zero");

        stakingRewards = address(
            new StakingRewards(
                /*_rewardsDistribution=*/ address(this),
                rewardsToken,
                stakingToken,
                /*_creator=*/ msg.sender,
                startTime,
                rewardsDuration,
                lockDuration,
                maxStakingPower
            )
        );
        // safe to narrow: the pool's constructor has already rejected anything out of range
        poolInfo[stakingRewards] = StakingRewardsInfo({
            creator: msg.sender,
            startTime: uint40(startTime),
            rewardsDuration: uint32(rewardsDuration),
            stakingToken: stakingToken,
            lockDuration: uint32(lockDuration),
            epoch: 1,
            rewardsToken: rewardsToken,
            rewardAmount: rewardAmount,
            maxStakingPower: uint128(maxStakingPower)
        });
        pools.push(stakingRewards);
        poolsByCreator[msg.sender].push(stakingRewards);

        IERC20(rewardsToken).safeTransferFrom(msg.sender, stakingRewards, rewardAmount);
        uint256 fee = feeAmount;
        if (fee > 0) {
            IERC20(feeToken).safeTransferFrom(msg.sender, feeReceiver, fee);
        }

        // rewards are in the pool now, so start the epoch immediately: a pool that exists is a
        // pool that is running, and there is no window where its funding sits stranded
        StakingRewards(stakingRewards).notifyRewardAmount(
            rewardAmount,
            startTime,
            rewardsDuration,
            lockDuration,
            maxStakingPower
        );
        emit Deployed(
            stakingToken,
            rewardsToken,
            stakingRewards,
            msg.sender,
            rewardAmount,
            startTime,
            rewardsDuration,
            lockDuration,
            maxStakingPower
        );
        emit EpochStarted(stakingRewards, 1, rewardAmount, startTime, rewardsDuration, lockDuration, maxStakingPower);
    }

    /// @notice Harvest several pools in one transaction. The one MasterChef / PancakeSwap
    /// convenience worth borrowing here, since one contract per pool otherwise means one claim
    /// transaction per pool.
    /// @dev Rewards are always paid to msg.sender: {StakingRewards.getRewardFor} pays the
    /// account it is given and this function only ever passes msg.sender, so a caller cannot
    /// redirect anybody else's payout to themselves. The loop is unbounded by design; the
    /// caller chooses the list and pays for it.
    /// @param poolAddresses pools to claim from. Each must have been created by this factory.
    function claimAll(address[] calldata poolAddresses) external {
        for (uint256 i = 0; i < poolAddresses.length;) {
            address pool = poolAddresses[i];
            require(poolInfo[pool].rewardsToken != address(0), "StakingRewardsFactory: not deployed");
            StakingRewards(pool).getRewardFor(msg.sender);
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Fund and schedule the next epoch of a pool that has already run one, reusing the
    /// same pool so stakers never have to unstake and restake between epochs. Each epoch picks
    /// its own budget, start time, length, lock and staking cap.
    /// @dev Creator only. Permissionless funding would be safe with a fixed schedule, but since
    /// an epoch chooses its own length a stranger could park the pool in a year long epoch
    /// funded with dust and lock the creator out, so the schedule stays with the creator.
    /// The caller funds `rewardAmount` from their own balance, and the pool's balance check
    /// bounds the rate by what it actually holds. A new epoch may only be opened once the
    /// previous one has ended, so a live epoch's rate can never change under the stakers who
    /// joined it, and a closed pool refuses further epochs.
    /// Rewards already earned in past epochs are untouched: the pool settles its accumulator
    /// before applying the new schedule.
    /// @param stakingRewards the pool to fund.
    /// @param rewardAmount total rewards for this epoch, not a per second rate.
    /// @param startTime timestamp this epoch begins accruing; 0 or past means immediately.
    /// @param rewardsDuration length of this epoch in seconds, at most one year.
    /// @param lockDuration seconds a stake made in this epoch is locked, independent of the
    /// epoch length but never longer than it.
    /// @param maxStakingPower cap on the total staked for this epoch. 0 means unlimited.
    function startEpoch(
        address stakingRewards,
        uint256 rewardAmount,
        uint256 startTime,
        uint256 rewardsDuration,
        uint256 lockDuration,
        uint256 maxStakingPower
    ) external nonReentrant {
        StakingRewardsInfo storage info = poolInfo[stakingRewards];
        require(msg.sender == info.creator, "StakingRewardsFactory: not the creator");
        require(rewardAmount > 0, "StakingRewardsFactory: reward amount is zero");
        require(
            block.timestamp >= StakingRewards(stakingRewards).periodFinish(),
            "StakingRewardsFactory: epoch not over"
        );
        // bound the values before they are narrowed into the packed index. The pool enforces the
        // same limits in notifyRewardAmount; checking here as well means a bad value reverts
        // rather than being silently truncated in the index on its way there
        uint256 maxDuration = StakingRewards(stakingRewards).MAX_DURATION();
        require(
            rewardsDuration > 0 && rewardsDuration <= maxDuration && lockDuration <= rewardsDuration,
            "StakingRewardsFactory: bad duration"
        );
        require(startTime <= block.timestamp + maxDuration, "StakingRewardsFactory: bad start time");
        require(maxStakingPower <= type(uint128).max, "StakingRewardsFactory: bad staking cap");

        uint32 epoch = info.epoch + 1;
        info.epoch = epoch;
        // keep the index describing the epoch that is actually running. Narrowing is safe here
        // for the same reason as in deploy: notifyRewardAmount below rejects anything the
        // narrower types could not hold, so an out of range value reverts rather than truncating
        info.rewardAmount = rewardAmount;
        info.startTime = uint40(startTime);
        info.rewardsDuration = uint32(rewardsDuration);
        info.lockDuration = uint32(lockDuration);
        info.maxStakingPower = uint128(maxStakingPower);

        IERC20(info.rewardsToken).safeTransferFrom(msg.sender, stakingRewards, rewardAmount);
        StakingRewards(stakingRewards).notifyRewardAmount(
            rewardAmount,
            startTime,
            rewardsDuration,
            lockDuration,
            maxStakingPower
        );
        emit EpochStarted(
            stakingRewards,
            epoch,
            rewardAmount,
            startTime,
            rewardsDuration,
            lockDuration,
            maxStakingPower
        );
    }
}
