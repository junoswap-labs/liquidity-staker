// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

// Inheritance
import "./interfaces/IStakingRewards.sol";
import "./RewardsDistributionRecipient.sol";
import "./libraries/KAP20.sol";

/// @title StakingRewards
/// @notice One staking pool: users stake `stakingToken` and share `rewardsToken` in proportion
/// to their stake, for a fixed epoch. Forked from Uniswap's liquidity-staker, which is itself
/// Synthetix's StakingRewards, and extended for KUB Chain with per epoch scheduling, locks,
/// a staking cap, batch claiming and recovery of rewards nobody could earn.
/// @dev Reward accounting is the O(1) accrual accumulator: rewardPerTokenStored advances by
/// rewardRate * elapsed / totalSupply, and each account's userRewardPerTokenPaid records where
/// it stood when they last touched the pool. This is the same maths as MasterChef's
/// accRewardPerShare / rewardDebt (PancakeSwap), in Synthetix naming.
/// Notes:
/// - every timestamp is block.timestamp, never block.number: KUB block times may change
///   (5s -> 3s -> 1s) and existing pools must not shift when they do.
/// - rewardRate is scaled by {PRECISION} = 1e36 and every step goes through Math.mulDiv.
///   1e18 was not enough: the accumulator step divides by totalStaked, so at 1e18 a settlement
///   discarded up to totalStaked / 1e18 reward units, and since anyone may force a settlement
///   with getRewardFor, a 6 decimal reward token (KUSDT) over a large pool could be ground down
///   to zero emissions for the cost of one transaction per block. See audit C-01.
/// - the schedule fields are packed into a single storage slot, and the token addresses are
///   immutable, so a stake or a claim touches as few cold slots as possible.
/// - all reward token movements go through SafeERC20, so KAP-20 tokens and other non standard
///   ERC20s are handled. Fee on transfer and rebasing tokens are NOT supported: the pool
///   assumes the balance it was funded with is the balance it can pay out.
contract StakingRewards is IStakingRewards, RewardsDistributionRecipient, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ========== CONSTANTS ========== */

    /// @notice longest epoch, and therefore longest lock, a pool will accept.
    /// @dev A cap rather than an open ended value so a mistyped duration cannot park a pool,
    /// or a staker's lock, for a decade.
    uint256 public constant MAX_DURATION = 365 days;

    /// @notice scaling factor of {rewardRate} and {rewardPerTokenStored}.
    /// @dev 1e36, not 1e18: the accumulator divides by totalStaked, so the scale has to exceed
    /// any realistic stake by enough that the per-settlement remainder is worthless. Every use
    /// goes through Math.mulDiv, whose 512-bit intermediate makes the larger scale free of
    /// overflow risk.
    uint256 public constant PRECISION = 1e36;

    /// @notice most live (non-drained) deposit lots one account may hold.
    /// @dev Bounds the withdrawal loop on the growth path. Without it an account could push its
    /// own lot array past the block gas limit and freeze its own principal for good.
    uint256 public constant MAX_LIVE_LOTS = 256;

    /* ========== IMMUTABLES ========== */

    /// @notice token paid out as rewards.
    IERC20 public immutable rewardsToken;
    /// @notice token users stake.
    IERC20 public immutable stakingToken;
    /// @notice whoever funded this pool. The only address that may {close} it and pull back
    /// unallocated rewards. Has no other power: it cannot pause, drain or reconfigure.
    address public immutable creator;

    /* ========== STATE VARIABLES ========== */

    // One slot: the whole schedule is read on every stake, withdraw and claim.
    /// @notice timestamp the current epoch's rewards begin accruing. Rewards accrue from here,
    /// not from the {notifyRewardAmount} transaction, so an epoch can be funded and scheduled
    /// ahead of time. Reset for every epoch.
    uint40 public startTime;
    /// @notice timestamp the current epoch ends. 0 until the pool is started.
    uint40 public periodFinish;
    /// @notice timestamp the accumulator was last advanced.
    uint40 public lastUpdateTime;
    /// @notice length of the current epoch in seconds. Chosen per epoch, not fixed at deploy.
    uint32 public rewardsDuration;
    /// @notice seconds a stake is locked before it can be withdrawn. 0 disables locking.
    /// Chosen per epoch, independently of the epoch's length.
    /// @dev Deliberately a duration in seconds, not blocks, so a change in KUB block time
    /// cannot silently lengthen or shorten locks that already exist. A lock is additionally
    /// capped at {periodFinish} when it is applied, so no stake is ever locked past the end of
    /// the epoch it was made in, however late in the epoch it arrives.
    uint32 public lockDuration;
    /// @notice true once the creator has retired the pool. Irreversible.
    /// @dev Closing blocks further epochs and is what unlocks {recoverUnallocatedRewards}.
    /// Stakers keep full access to {withdraw}, {getReward} and {exit} afterwards.
    bool public closed;

    // One slot: both are read and written together by every stake.
    uint128 private _totalSupply;
    /// @notice cap on the total staked in this pool. 0 means unlimited.
    /// @dev For pools with a limited allocation. Lowering it never forces anyone out, it only
    /// stops new stakes; existing stakers keep their position and their rewards.
    uint128 public maxStakingPower;

    /// @notice rewards per second, scaled by {PRECISION}.
    uint256 public rewardRate;
    /// @notice accrued rewards per staked token, scaled by {PRECISION}.
    uint256 public rewardPerTokenStored;
    /// @notice rewards that accrued while nobody was staked, and so can never be earned.
    /// @dev Claimable by {creator} through {recoverUnallocatedRewards} once the pool is closed.
    uint256 public unallocatedRewards;

    /// @dev Every stake becomes its own lot with its own unlock time, so topping up never
    /// re-locks tokens that were already staked, and never lets an old lot ride out early on a
    /// new one. Indexes are stable: a drained lot stays in place as a zero amount entry, so a
    /// front end can keep referring to a lot by its index. One lot is one storage slot.
    mapping(address => IStakingRewards.Deposit[]) private _deposits;
    /// @dev First lot that may still hold something, so a long history of drained lots does not
    /// have to be walked on every withdrawal.
    mapping(address => uint256) private _withdrawCursor;
    // rewardPerTokenStored / userRewardPerTokenPaid are the same accrual accumulator as
    // MasterChef's accRewardPerShare / rewardDebt (PancakeSwap), kept in Synthetix naming,
    // scaled by PRECISION (1e36) rather than MasterChef's 1e12.
    /// @notice accumulator value each account was last settled at.
    mapping(address => uint256) public userRewardPerTokenPaid;
    /// @notice rewards already settled and waiting to be claimed, per account.
    mapping(address => uint256) public rewards;

    mapping(address => uint256) private _balances;

    /* ========== CONSTRUCTOR ========== */

    constructor(
        address _rewardsDistribution,
        address _rewardsToken,
        address _stakingToken,
        address _creator,
        uint256 _startTime,
        uint256 _rewardsDuration,
        uint256 _lockDuration,
        uint256 _maxStakingPower
    ) RewardsDistributionRecipient(_rewardsDistribution) {
        require(_rewardsDuration > 0 && _rewardsDuration <= MAX_DURATION, "Bad rewards duration");
        require(_lockDuration <= _rewardsDuration, "Lock longer than epoch");
        require(_startTime <= block.timestamp + MAX_DURATION, "Bad start time");
        require(_maxStakingPower <= type(uint128).max, "Bad staking cap");

        rewardsToken = IERC20(_rewardsToken);
        stakingToken = IERC20(_stakingToken);
        creator = _creator;
        startTime = SafeCast.toUint40(_startTime);
        rewardsDuration = uint32(_rewardsDuration);
        lockDuration = uint32(_lockDuration);
        maxStakingPower = uint128(_maxStakingPower);
    }

    /* ========== VIEWS ========== */

    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    /// @notice last timestamp rewards are counted up to.
    /// @dev Floored at {startTime} so nothing accrues before the pool is scheduled to open,
    /// and capped at {periodFinish} so nothing accrues after it closes.
    function lastTimeRewardApplicable() public view returns (uint256) {
        return Math.max(startTime, Math.min(block.timestamp, periodFinish));
    }

    function rewardPerToken() public view returns (uint256) {
        uint256 supply = _totalSupply;
        uint256 applicable = lastTimeRewardApplicable();
        uint256 last = lastUpdateTime;
        if (supply == 0 || applicable <= last) {
            return rewardPerTokenStored;
        }
        // mulDiv keeps the full 512-bit intermediate, so PRECISION can be large enough that
        // the discarded remainder is worthless at any realistic stake size
        return rewardPerTokenStored + Math.mulDiv(applicable - last, rewardRate, supply);
    }

    function earned(address account) public view returns (uint256) {
        return _earned(account, rewardPerToken());
    }

    /// @dev Settles `account` against an accumulator value the caller has already computed.
    /// {updateReward} advances the accumulator and then settles from the same local, so a stake
    /// or a claim runs the accrual maths once instead of twice.
    /// `rpt` is monotonic and userRewardPerTokenPaid is only ever assigned from it, so the
    /// subtraction cannot underflow; it is left checked regardless.
    function _earned(address account, uint256 rpt) private view returns (uint256) {
        return Math.mulDiv(
            _balances[account],
            rpt - userRewardPerTokenPaid[account],
            PRECISION
        ) + rewards[account];
    }

    /// @notice rewards this epoch pays out in total, dust aside.
    function getRewardForDuration() external view returns (uint256) {
        return Math.mulDiv(rewardRate, rewardsDuration, PRECISION);
    }

    /// @notice how much more may still be staked before {maxStakingPower} is reached.
    /// @dev type(uint256).max when the pool is uncapped.
    function remainingStakingPower() external view returns (uint256) {
        uint256 cap = maxStakingPower;
        if (cap == 0) return type(uint256).max;
        uint256 supply = _totalSupply;
        return cap > supply ? cap - supply : 0;
    }

    /// @notice number of deposit lots `user` has ever made, drained ones included.
    /// @dev Also the next index a new stake will take. Iterate 0..n-1 with
    /// {getUserInfoByIndex}, or read a page at once with {getUserInfos}.
    function totalUserStakedIndex(address user) external view returns (uint256) {
        return _deposits[user].length;
    }

    /// @notice one deposit lot: how much is left in it, when it was made, when it unlocks.
    function getUserInfoByIndex(address user, uint256 index)
        external
        view
        returns (IStakingRewards.Deposit memory)
    {
        return _deposits[user][index];
    }

    /// @notice every deposit lot of `user`, as an array of tuples.
    /// @dev Unbounded, for off chain callers. On chain callers should use {getUserInfosPaged}.
    function getUserInfos(address user) external view returns (IStakingRewards.Deposit[] memory) {
        return _deposits[user];
    }

    /// @notice a page of `user`'s deposit lots, starting at `start`, at most `count` of them.
    /// @dev Returns a short array near the end rather than reverting.
    function getUserInfosPaged(address user, uint256 start, uint256 count)
        public
        view
        returns (IStakingRewards.Deposit[] memory page)
    {
        IStakingRewards.Deposit[] storage lots = _deposits[user];
        uint256 len = lots.length;
        if (start >= len) return new IStakingRewards.Deposit[](0);

        uint256 end = start + count;
        if (end > len) end = len;
        page = new IStakingRewards.Deposit[](end - start);
        for (uint256 i = start; i < end;) {
            page[i - start] = lots[i];
            unchecked {
                ++i;
            }
        }
    }

    /// @notice how much of `user`'s stake is unlocked and withdrawable right now.
    function withdrawableOf(address user) public view returns (uint256 amount) {
        IStakingRewards.Deposit[] storage lots = _deposits[user];
        uint256 len = lots.length;
        for (uint256 i = _withdrawCursor[user]; i < len;) {
            IStakingRewards.Deposit storage lot = lots[i];
            if (block.timestamp >= lot.unlockAt) amount += lot.amount;
            unchecked {
                ++i;
            }
        }
    }

    /// @notice when `user`'s next locked lot unlocks. 0 when nothing is locked.
    function nextUnlockAt(address user) external view returns (uint256 at) {
        IStakingRewards.Deposit[] storage lots = _deposits[user];
        uint256 len = lots.length;
        for (uint256 i = _withdrawCursor[user]; i < len;) {
            IStakingRewards.Deposit storage lot = lots[i];
            if (lot.amount > 0 && lot.unlockAt > block.timestamp && (at == 0 || lot.unlockAt < at)) {
                at = lot.unlockAt;
            }
            unchecked {
                ++i;
            }
        }
    }

    /// @notice allowance this pool holds to pull `account`'s staking tokens.
    /// @dev View helper for front ends. Reads the ERC20 `allowance` getter and falls back to
    /// the KAP-20 `allowances` getter, which is all some KUB tokens such as KUSDT expose.
    function stakingAllowance(address account) external view returns (uint256) {
        return KAP20.allowanceOf(address(stakingToken), account, address(this));
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    /// @notice Stake `amount`, approving in the same transaction with an EIP-2612 permit.
    /// @dev Only usable with staking tokens that implement permit, such as Uniswap V2 style LP
    /// tokens. KAP-20 tokens have no permit; those stakers use {stake} after approve.
    function stakeWithPermit(
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant updateReward(msg.sender) {
        IUniswapV2ERC20(address(stakingToken)).permit(msg.sender, address(this), amount, deadline, v, r, s);
        uint256 received = _pull(amount);
        _credit(received);
        emit Staked(msg.sender, received);
    }

    /// @notice Stake `amount` of {stakingToken}. Requires a prior approve.
    /// @dev Credits what the pool actually received, which is what keeps the accounting exact
    /// for a fee on transfer or deflationary staking token instead of silently promising more
    /// than the pool holds. Opens a new deposit lot locked for {lockDuration}.
    function stake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        uint256 received = _pull(amount);
        _credit(received);
        emit Staked(msg.sender, received);
    }

    /// @dev Pulls `amount` and returns what actually arrived. The balance delta, not the
    /// requested figure, is what the pool can pay back later; see audit H-01.
    function _pull(uint256 amount) private returns (uint256 received) {
        uint256 balanceBefore = stakingToken.balanceOf(address(this));
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        received = stakingToken.balanceOf(address(this)) - balanceBefore;
    }

    /// @notice Withdraw staked tokens, taken from the caller's unlocked lots, oldest first.
    /// @dev Reverts with "Still locked" when the unlocked lots do not add up to `amount`; use
    /// {withdrawableOf} to see what is available. Rewards are untouched by withdrawing; claim
    /// them with {getReward}. There is no emergency exit that skips the lock, by design: the
    /// lock is what stakers were promised.
    function withdraw(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot withdraw 0");
        require(_take(msg.sender, amount) == amount, "Still locked");
        _payOut(msg.sender, amount);
    }

    /// @notice Withdraw from one specific deposit lot, in constant gas.
    /// @dev The escape hatch for an account holding many lots: it reaches an unlocked lot
    /// directly instead of scanning everything before it. Use {getUserInfos} to find the index.
    function withdrawFrom(uint256 index, uint256 amount)
        external
        nonReentrant
        updateReward(msg.sender)
    {
        require(amount > 0, "Cannot withdraw 0");

        IStakingRewards.Deposit storage lot = _deposits[msg.sender][index];
        require(block.timestamp >= lot.unlockAt, "Still locked");
        require(lot.amount >= amount, "Amount exceeds lot");

        lot.amount -= uint128(amount);
        _sweep(msg.sender);
        _payOut(msg.sender, amount);
    }

    /// @notice Claim the caller's accrued rewards. Never blocked by {lockDuration}.
    function getReward() external {
        getRewardFor(msg.sender);
    }

    /// @notice Claim `account`'s accrued rewards, paying `account`.
    /// @dev Callable by anyone precisely because the payout goes to `account` and never to the
    /// caller, which is what lets {StakingRewardsFactory.claimAll} batch claims safely. A stranger
    /// calling it still forces a settlement, though, so the accumulator has to survive being
    /// stepped one block at a time - that is what {PRECISION} = 1e36 is for. See audit C-01.
    function getRewardFor(address account) public nonReentrant updateReward(account) {
        _claim(account);
    }

    /// @notice Withdraw everything the caller has unlocked and claim their rewards.
    /// @dev Locked lots stay staked and keep earning; call again once they unlock.
    /// Does the work itself rather than calling {withdraw} and {getReward}: those would settle
    /// the accumulator twice, take the reentrancy guard twice and walk the lot array twice,
    /// which the staker pays for. One pass, one settle, one guard.
    function exit() external nonReentrant updateReward(msg.sender) {
        uint256 amount = _take(msg.sender, type(uint256).max);
        if (amount > 0) _payOut(msg.sender, amount);
        _claim(msg.sender);
    }

    /// @notice how many live (non-drained) deposit lots `user` holds, against {MAX_LIVE_LOTS}.
    function liveLots(address user) public view returns (uint256) {
        return _deposits[user].length - _withdrawCursor[user];
    }

    /// @dev The tail every withdrawal path shares. The lots have already been debited.
    function _payOut(address account, uint256 amount) private {
        _totalSupply -= uint128(amount);
        _balances[account] -= amount;
        stakingToken.safeTransfer(account, amount);
        emit Withdrawn(account, amount);
    }

    /// @dev Pays out whatever is already settled for `account`. Shared by {getRewardFor} and
    /// {exit}; the caller is responsible for having run {updateReward} first.
    function _claim(address account) private {
        uint256 reward = rewards[account];
        if (reward > 0) {
            rewards[account] = 0;
            rewardsToken.safeTransfer(account, reward);
            emit RewardPaid(account, reward);
        }
    }

    /// @dev Skips the drained prefix so a long history of empty lots is never walked again.
    /// Called by both withdrawal paths, including the by-index one, so an account that empties
    /// every lot through {withdrawFrom} still frees room under {MAX_LIVE_LOTS}.
    function _sweep(address account) private {
        IStakingRewards.Deposit[] storage lots = _deposits[account];
        uint256 len = lots.length;
        uint256 cursor = _withdrawCursor[account];
        while (cursor < len && lots[cursor].amount == 0) {
            unchecked {
                ++cursor;
            }
        }
        _withdrawCursor[account] = cursor;
    }

    /// @dev Shared book keeping for both stake paths: cap checks, balances, lock.
    function _credit(uint256 amount) private {
        require(amount > 0, "Cannot stake 0");
        // bound the withdrawal loop where the array grows, not where it is walked
        require(liveLots(msg.sender) < MAX_LIVE_LOTS, "Too many deposit lots");

        uint256 supply = _totalSupply + amount;
        uint256 cap = maxStakingPower;
        require(cap == 0 || supply <= cap, "Staking cap reached");
        // totalSupply and each lot are uint128; without this an uncapped pool over a token
        // with an absurd supply would truncate on the cast instead of reverting
        require(supply <= type(uint128).max, "Amount too large");

        _totalSupply = uint128(supply);
        _balances[msg.sender] += amount;
        _deposits[msg.sender].push(
            IStakingRewards.Deposit({
                amount: uint128(amount),
                stakedAt: SafeCast.toUint40(block.timestamp),
                unlockAt: SafeCast.toUint40(_lockUntil())
            })
        );
    }

    /// @dev Takes up to `wanted` out of `account`'s unlocked lots, oldest first, skipping the
    /// ones still locked, and returns what it managed to take. Locked lots are never touched, so
    /// an early lot that is still locked cannot block a later one that has already unlocked.
    /// `type(uint256).max` drains everything unlocked in the same single pass, which is what
    /// {exit} uses instead of measuring first with {withdrawableOf} and debiting after.
    function _take(address account, uint256 wanted) private returns (uint256 taken) {
        IStakingRewards.Deposit[] storage lots = _deposits[account];
        uint256 len = lots.length;
        uint256 remaining = wanted;

        for (uint256 i = _withdrawCursor[account]; i < len && remaining > 0;) {
            IStakingRewards.Deposit storage lot = lots[i];
            uint128 held = lot.amount;
            if (held > 0 && block.timestamp >= lot.unlockAt) {
                uint128 take = remaining < held ? uint128(remaining) : held;
                lot.amount = held - take;
                unchecked {
                    remaining -= take;
                    taken += take;
                }
            }
            unchecked {
                ++i;
            }
        }

        _sweep(account);
    }

    /// @dev When a stake unlocks: now + lockDuration, but never past the end of the epoch it
    /// was made in. A stake made in the last day of an epoch with a 7 day lock unlocks at the
    /// epoch end, not a week later, so nobody is ever locked in beyond the rewards they staked
    /// for. Past the epoch end this returns the past, i.e. no lock at all.
    function _lockUntil() private view returns (uint256) {
        uint256 end = periodFinish;
        if (end == 0) {
            // not started yet: cap against the epoch end the pool is already scheduled for
            end = Math.max(block.timestamp, startTime) + rewardsDuration;
        }
        return Math.min(block.timestamp + lockDuration, end);
    }

    /* ========== RESTRICTED FUNCTIONS ========== */

    /// @notice Start an epoch on its own schedule. Only the rewards distributor, i.e. the
    /// factory, which is what keeps `reward` equal to what was actually transferred in.
    /// @dev The rewards must already sit in this contract; the balance check below is what
    /// bounds rewardRate by real funds and stops an over stated `reward` from creating a rate
    /// the pool cannot pay. Accrual runs from max(now, _startTime) for _rewardsDuration.
    /// The modifier settles the previous epoch first, so nothing already earned is disturbed
    /// and the gap between epochs accrues to nobody.
    /// @param reward total rewards for this epoch, not a per second rate.
    /// @param _startTime timestamp this epoch begins accruing; 0 or past means immediately.
    /// @param _rewardsDuration length of this epoch in seconds, at most {MAX_DURATION}.
    /// @param _lockDuration seconds a stake made in this epoch is locked. Must not exceed the
    /// epoch length, and is capped at the epoch end when applied.
    /// @param _maxStakingPower cap on the total staked, 0 for unlimited.
    function notifyRewardAmount(
        uint256 reward,
        uint256 _startTime,
        uint256 _rewardsDuration,
        uint256 _lockDuration,
        uint256 _maxStakingPower
    ) external override onlyRewardsDistribution updateReward(address(0)) {
        require(!closed, "Pool closed");
        require(_rewardsDuration > 0 && _rewardsDuration <= MAX_DURATION, "Bad rewards duration");
        require(_lockDuration <= _rewardsDuration, "Lock longer than epoch");
        require(_startTime <= block.timestamp + MAX_DURATION, "Bad start time");
        require(_maxStakingPower <= type(uint128).max, "Bad staking cap");

        startTime = SafeCast.toUint40(_startTime);
        rewardsDuration = uint32(_rewardsDuration);
        lockDuration = uint32(_lockDuration);
        maxStakingPower = uint128(_maxStakingPower);

        uint256 rate = Math.mulDiv(reward, PRECISION, _rewardsDuration);
        require(rate > 0, "Reward rate is zero");

        // Ensure the provided reward amount is not more than the balance in the contract.
        // This keeps the reward rate in the right range and stops an over stated `reward` from
        // creating a rate the pool cannot pay.
        uint256 balance = rewardsToken.balanceOf(address(this));
        require(rate <= Math.mulDiv(balance, PRECISION, _rewardsDuration), "Provided reward too high");

        rewardRate = rate;
        uint256 begin = Math.max(block.timestamp, _startTime);
        lastUpdateTime = SafeCast.toUint40(begin);
        periodFinish = SafeCast.toUint40(begin + _rewardsDuration);
        emit RewardAdded(reward);
    }

    /// @notice Retire the pool for good. Creator only, and only between epochs.
    /// @dev Irreversible. Blocks any further epoch and unlocks {recoverUnallocatedRewards}.
    /// Cannot be called mid epoch, so it can never cut short rewards stakers were promised,
    /// and it never restricts withdrawing or claiming.
    function close() external {
        require(msg.sender == creator, "Not the creator");
        require(periodFinish != 0 && block.timestamp > periodFinish, "Epoch not over");
        require(!closed, "Already closed");

        closed = true;
        emit Closed(block.timestamp);
    }

    /// @notice Pull back rewards nobody could earn. Creator only, and only after {close}:
    /// while another epoch is still possible, leftovers stay in the pool as its funding.
    /// @dev Whenever totalSupply is 0 the clock still runs but no staker can accrue, so that
    /// slice of the budget is unreachable; {unallocatedRewards} tracks exactly that amount and
    /// nothing else. Stakers' earned rewards are never in scope: the amount is additionally
    /// capped at the free balance, with staked principal subtracted when the staking token and
    /// the reward token happen to be the same.
    /// @return amount rewards returned to the creator.
    function recoverUnallocatedRewards() external updateReward(address(0)) returns (uint256 amount) {
        require(msg.sender == creator, "Not the creator");
        require(closed, "Pool not closed");

        uint256 free = rewardsToken.balanceOf(address(this));
        if (address(rewardsToken) == address(stakingToken)) {
            free -= _totalSupply;
        }
        amount = Math.min(unallocatedRewards, free);

        if (amount > 0) {
            uint256 tracked = unallocatedRewards;
            unallocatedRewards = amount < tracked ? tracked - amount : 0;
            rewardsToken.safeTransfer(creator, amount);
            emit RewardsRecovered(creator, amount);
        }
    }

    /* ========== MODIFIERS ========== */

    /// @dev Settles the accumulator up to now, then settles `account` against it. Runs before
    /// every balance change, so a stake or withdrawal never rewrites history for past seconds.
    /// Reads _totalSupply before the function body changes it, which is what makes the empty
    /// pool accounting in {unallocatedRewards} exact.
    modifier updateReward(address account) {
        uint256 applicable = lastTimeRewardApplicable();
        uint256 last = lastUpdateTime;
        uint256 rpt = rewardPerTokenStored;
        if (applicable > last) {
            uint256 supply = _totalSupply;
            if (supply == 0) {
                // nobody could earn this slice; the creator may recover it once the pool closes
                unallocatedRewards += Math.mulDiv(applicable - last, rewardRate, PRECISION);
            } else {
                rpt += Math.mulDiv(applicable - last, rewardRate, supply);
                rewardPerTokenStored = rpt;
            }
            lastUpdateTime = SafeCast.toUint40(applicable);
        }
        if (account != address(0)) {
            rewards[account] = _earned(account, rpt);
            userRewardPerTokenPaid[account] = rpt;
        }
        _;
    }

    /* ========== EVENTS ========== */

    event RewardAdded(uint256 reward);
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardsRecovered(address indexed to, uint256 amount);
    event Closed(uint256 timestamp);
}

interface IUniswapV2ERC20 {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
