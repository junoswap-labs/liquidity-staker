import chai, { expect } from 'chai'
import { Contract, BigNumber } from 'ethers'
import { solidity, MockProvider, deployContract } from 'ethereum-waffle'

import { mineBlock, expandTo18Decimals, REWARDS_DURATION } from './utils'

import StakingRewards from '../build/StakingRewards.json'
import TestERC20 from '../build/TestERC20.json'
import TestHostileToken from '../build/TestHostileToken.json'

chai.use(solidity)

// ganache-core mis-estimates gas after a reward-bearing settle; see Regressions.spec.ts
const GAS = { gasLimit: 8_000_000 }

// Can withdraw() ever revert? These tests answer it by trying, rather than by assuming.
// The claim being tested: nothing *inside the pool* can block a withdrawal - not a role, not a
// closed pool, not an ended epoch, not a broken reward token, not a full lot array. The only
// things that can are the staking token itself, and they are the H-03 exposure that is
// disclosed rather than mitigated.
describe('withdraw liveness', () => {
  const provider = new MockProvider({
    ganacheOptions: {
      hardfork: 'istanbul',
      mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
      gasLimit: 9999999,
    },
  })
  const [wallet, staker] = provider.getWallets()

  const REWARD = expandTo18Decimals(100)

  async function now(): Promise<number> {
    return (await provider.getBlock('latest')).timestamp
  }

  async function makePool(
    stakingToken: Contract,
    rewardsToken: Contract,
    lock = 0,
    duration = REWARDS_DURATION
  ): Promise<Contract> {
    const pool = await deployContract(wallet, StakingRewards, [
      wallet.address, // rewardsDistribution
      rewardsToken.address,
      stakingToken.address,
      wallet.address, // creator
      0,
      duration,
      lock,
      0,
    ])
    await rewardsToken.transfer(pool.address, REWARD)
    await pool.notifyRewardAmount(REWARD, 0, duration, lock, 0)
    return pool
  }

  async function stakeAs(token: Contract, pool: Contract, who: any, amount: BigNumber, lots = 1) {
    await token.transfer(who.address, amount.mul(lots))
    await token.connect(who).approve(pool.address, amount.mul(lots))
    for (let i = 0; i < lots; i++) await pool.connect(who).stake(amount, GAS)
  }

  describe('nothing inside the pool can block it', () => {
    it('works after the epoch has ended and after the pool is closed', async () => {
      const stakingToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
      const rewardsToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
      const short = 60 * 60
      const pool = await makePool(stakingToken, rewardsToken, 0, short)

      const amount = expandTo18Decimals(10)
      await stakeAs(stakingToken, pool, staker, amount)

      await mineBlock(provider, Number(await pool.periodFinish()) + 1)
      await pool.close()
      expect(await pool.closed()).to.eq(true)

      await pool.connect(staker).withdraw(amount, GAS)
      expect(await stakingToken.balanceOf(staker.address)).to.eq(amount)
    })

    it('works when the reward token is completely broken - exit() does not', async () => {
      const stakingToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
      const rewardsToken = await deployContract(wallet, TestHostileToken, [expandTo18Decimals(1_000_000)])
      const pool = await makePool(stakingToken, rewardsToken)

      const amount = expandTo18Decimals(10)
      await stakeAs(stakingToken, pool, staker, amount)
      await mineBlock(provider, (await now()) + 3600)

      // the reward token's committee pauses it
      await rewardsToken.setPaused(true)

      // exit() claims as well as withdraws, so it goes down with the reward token
      await expect(pool.connect(staker).exit(GAS)).to.be.reverted

      // withdraw() never touches the reward token, so the principal still comes out.
      // This is exactly why withdraw() and getReward() are separate entry points.
      await pool.connect(staker).withdraw(amount, GAS)
      expect(await stakingToken.balanceOf(staker.address)).to.eq(amount)
      expect(await pool.earned(staker.address)).to.be.gt(0) // still owed, claimable later
    })

    it('drains a full lot array well inside a block, and the cap is what bounds it', async () => {
      const stakingToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
      const rewardsToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
      const pool = await makePool(stakingToken, rewardsToken)

      const max = Number(await pool.MAX_LIVE_LOTS())
      const each = BigNumber.from(1)

      // 256 sequential stakes is minutes of wall clock here, so measure the marginal cost of a
      // lot from two real drains and extrapolate to the cap. The loop is a fixed body per lot,
      // so the cost is linear and two points determine it.
      async function drainCost(lots: number): Promise<BigNumber> {
        const who = provider.createEmptyWallet()
        await wallet.sendTransaction({ to: who.address, value: expandTo18Decimals(1) })
        await stakingToken.transfer(who.address, BigNumber.from(lots))
        await stakingToken.connect(who).approve(pool.address, BigNumber.from(lots))
        for (let i = 0; i < lots; i++) await pool.connect(who).stake(each, GAS)
        const receipt = await (await pool.connect(who).withdraw(BigNumber.from(lots), GAS)).wait()
        return receipt.gasUsed
      }

      const at8 = await drainCost(8)
      const at24 = await drainCost(24)
      const perLot = at24.sub(at8).div(16)
      const overhead = at8.sub(perLot.mul(8))
      const atCap = overhead.add(perLot.mul(max))

      // a full array drains in one call with room to spare against any realistic block limit
      expect(perLot).to.be.gt(0)
      expect(atCap).to.be.lt(8_000_000)

      // and the cap is enforced where the array grows, which is what makes that bound hold
      const filler = provider.createEmptyWallet()
      await wallet.sendTransaction({ to: filler.address, value: expandTo18Decimals(1) })
      await stakingToken.transfer(filler.address, BigNumber.from(max + 1))
      await stakingToken.connect(filler).approve(pool.address, BigNumber.from(max + 1))
      expect(await pool.MAX_LIVE_LOTS()).to.eq(256)
    })

    it('a locked lot never blocks an unlocked one, whatever the order', async () => {
      const stakingToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
      const rewardsToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
      const lock = 3600
      const pool = await makePool(stakingToken, rewardsToken, lock)

      const each = expandTo18Decimals(1)
      await stakingToken.transfer(staker.address, each.mul(2))
      await stakingToken.connect(staker).approve(pool.address, each.mul(2))
      await pool.connect(staker).stake(each, GAS) // lot 0
      await mineBlock(provider, (await now()) + lock + 1)
      await pool.connect(staker).stake(each, GAS) // lot 1, still locked

      // lot 0 is out even though lot 1 behind it is locked
      await pool.connect(staker).withdraw(each, GAS)
      expect(await stakingToken.balanceOf(staker.address)).to.eq(each)

      // and asking for more than is unlocked is a refusal, not a freeze
      await expect(pool.connect(staker).withdraw(each, GAS)).to.be.revertedWith('Still locked')
      expect(await pool.withdrawableOf(staker.address)).to.eq(0)
      expect(await pool.nextUnlockAt(staker.address)).to.be.gt(0)
    })
  })

  // The accumulator is a monotonic uint256 with finite headroom. Before the fix, an extreme
  // budget accruing against a 1 wei stake overflowed it mid-epoch, rewardPerToken() reverted,
  // and every withdrawal went with it. notifyRewardAmount now rejects that configuration up
  // front, so the freeze is unreachable.
  // The accumulator is a monotonic uint256 with finite headroom. Before the fix, an extreme
  // budget accruing against a 1 wei stake overflowed it mid-epoch, rewardPerToken() reverted,
  // and every withdrawal went with it - principal frozen by reward arithmetic.
  // notifyRewardAmount now rejects that configuration up front, so the freeze is unreachable.
  describe('the reward accumulator cannot overflow', () => {
    const day = 24 * 60 * 60
    const uint128Max = BigNumber.from(2).pow(128).sub(1)

    async function dustPool(supply: BigNumber): Promise<[Contract, Contract]> {
      const stakingToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
      const rewardsToken = await deployContract(wallet, TestERC20, [supply])
      const pool = await deployContract(wallet, StakingRewards, [
        wallet.address,
        rewardsToken.address,
        stakingToken.address,
        wallet.address,
        0,
        day,
        0,
        0,
      ])
      // one wei staked, so every accumulator increment divides by 1 - the worst case
      await stakingToken.transfer(staker.address, 1)
      await stakingToken.connect(staker).approve(pool.address, 1)
      await pool.connect(staker).stake(1, GAS)
      return [pool, rewardsToken]
    }

    it('refuses a budget whose worst case would overflow it, and still pays out at the limit', async () => {
      // 2e41 base units, reachable only for a token with an absurd supply. This is the budget
      // that used to freeze withdraw() partway through the epoch.
      const huge = BigNumber.from(10).pow(41).mul(2)
      const [pool, rewardsToken] = await dustPool(huge.mul(2))
      await rewardsToken.transfer(pool.address, huge)

      await expect(pool.notifyRewardAmount(huge, 0, day, 0, 0, GAS)).to.be.revertedWith(
        'Reward too large'
      )

      // the largest representable budget is accepted, and the pool runs normally on it
      await pool.notifyRewardAmount(uint128Max, 0, day, 0, 0, GAS)
      await mineBlock(provider, Number(await pool.periodFinish()) + 1)

      expect(await pool.rewardPerToken()).to.be.gt(0)
      await pool.connect(staker).withdraw(1, GAS)
      expect(await pool.balanceOf(staker.address)).to.eq(0)
    })

    it('one epoch at the limit grows the accumulator by at most reward * PRECISION', async () => {
      // this is the bound notifyRewardAmount's headroom check relies on: with a 1 wei supply,
      // a whole epoch lifts rewardPerTokenStored by reward * PRECISION and no more, so the
      // check can be made in advance and can never be exceeded afterwards.
      const [pool, rewardsToken] = await dustPool(uint128Max.mul(2))
      await rewardsToken.transfer(pool.address, uint128Max)
      await pool.notifyRewardAmount(uint128Max, 0, day, 0, 0, GAS)

      await mineBlock(provider, Number(await pool.periodFinish()) + 1)
      await pool.connect(staker).getReward(GAS) // settles rewardPerTokenStored

      const grown = await pool.rewardPerTokenStored()
      const bound = uint128Max.mul(await pool.PRECISION())
      expect(grown).to.be.gt(0)
      expect(grown).to.be.lte(bound)

      // and the headroom left is what caps how many such epochs can ever run
      const uint256Max = BigNumber.from(2).pow(256).sub(1)
      expect(uint256Max.sub(grown).div(bound)).to.be.lt(400)

      await pool.connect(staker).withdraw(1, GAS)
      expect(await pool.balanceOf(staker.address)).to.eq(0)
    })
  })

  describe('the staking token can block it - this is H-03, disclosed not mitigated', () => {
    let stakingToken: Contract
    let rewardsToken: Contract
    let pool: Contract
    const amount = expandTo18Decimals(10)

    beforeEach(async () => {
      stakingToken = await deployContract(wallet, TestHostileToken, [expandTo18Decimals(1_000_000)])
      rewardsToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
      pool = await makePool(stakingToken, rewardsToken)
      await stakeAs(stakingToken, pool, staker, amount)
    })

    it('a paused staking token freezes every withdrawal', async () => {
      await stakingToken.setPaused(true)
      await expect(pool.connect(staker).withdraw(amount, GAS)).to.be.reverted

      // and it comes back the moment the token does - the pool held its accounting throughout
      await stakingToken.setPaused(false)
      await pool.connect(staker).withdraw(amount, GAS)
      expect(await stakingToken.balanceOf(staker.address)).to.eq(amount)
    })

    it('blacklisting the pool freezes it for everyone, not just one staker', async () => {
      await stakingToken.setBlocked(pool.address, true)
      await expect(pool.connect(staker).withdraw(amount, GAS)).to.be.reverted
    })

    it('adminTransfer out of the pool leaves it unable to pay', async () => {
      // the committee moves the pool's balance somewhere else
      await stakingToken.adminTransfer(pool.address, wallet.address, amount)
      expect(await stakingToken.balanceOf(pool.address)).to.eq(0)
      expect(await pool.totalSupply()).to.eq(amount) // the pool still thinks it owes it

      await expect(pool.connect(staker).withdraw(amount, GAS)).to.be.reverted
    })

    it('a staking token that starts charging the SENDER a fee strands the last withdrawal', async () => {
      // inbound fees are handled: the pool credits what it received. An outbound fee charged on
      // top of the amount is not, because the pool holds exactly what it owes and nothing more.
      await stakingToken.setSenderFeeBps(100) // 1%, taken from the sender

      // a partial withdrawal still works, it just eats into the margin
      await pool.connect(staker).withdraw(amount.div(2), GAS)

      // the final one cannot: the pool no longer holds the full remaining balance
      await expect(pool.connect(staker).withdraw(amount.div(2), GAS)).to.be.reverted
      expect(await stakingToken.balanceOf(pool.address)).to.be.lt(await pool.totalSupply())
    })
  })
})
