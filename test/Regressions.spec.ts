import chai, { expect } from 'chai'
import { Contract, BigNumber } from 'ethers'
import { solidity, MockProvider, deployContract } from 'ethereum-waffle'

import { mineBlock, expandTo18Decimals, REWARDS_DURATION } from './utils'

import StakingRewards from '../build/StakingRewards.json'
import StakingRewardsFactory from '../build/StakingRewardsFactory.json'
import TestERC20 from '../build/TestERC20.json'
import TestERC20Decimals from '../build/TestERC20Decimals.json'
import TestFeeToken from '../build/TestFeeToken.json'

chai.use(solidity)

// see the note in the reuse suite: ganache-core mis-estimates gas here
const GAS = { gasLimit: 4_000_000 }

// Regressions for the findings in audit/findings.json. Each one fails on the code as audited.
describe('audit regressions', () => {
  const provider = new MockProvider({
    ganacheOptions: {
      hardfork: 'istanbul',
      mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
      gasLimit: 9999999,
    },
  })
  const [wallet, staker, attacker] = provider.getWallets()

  async function now(): Promise<number> {
    return (await provider.getBlock('latest')).timestamp
  }

  // C-01: anyone may force a settlement, so the accumulator step has to survive being taken
  // one second at a time on a 6 decimal reward token.
  it('C-01: settling every second does not grind emissions to zero', async () => {
    const decimals = 6
    const unit = BigNumber.from(10).pow(decimals)
    const rewardsToken = await deployContract(wallet, TestERC20Decimals, [unit.mul(1_000_000), decimals])
    const stakingToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])

    const pool = await deployContract(wallet, StakingRewards, [
      wallet.address,
      rewardsToken.address,
      stakingToken.address,
      wallet.address,
      0,
      REWARDS_DURATION,
      0,
      0,
    ])

    // a large stake is what makes the division bite: 1000 KUSDT over 200k staked tokens
    const stake = expandTo18Decimals(200_000)
    await stakingToken.transfer(staker.address, stake)
    await stakingToken.connect(staker).approve(pool.address, stake)
    await pool.connect(staker).stake(stake)

    const reward = unit.mul(1000)
    await rewardsToken.transfer(pool.address, reward)
    await pool.notifyRewardAmount(reward, 0, REWARDS_DURATION, 0, 0)

    const start = await now()
    // the attack: settle the accumulator once a second, for free, from an unprivileged address
    for (let i = 0; i < 6; i++) {
      await mineBlock(provider, (await now()) + 1)
      await pool.connect(attacker).getRewardFor(staker.address)
    }

    const elapsed = (await now()) - start
    const expected = reward.mul(elapsed).div(REWARDS_DURATION)
    const paid = await rewardsToken.balanceOf(staker.address)

    expect(expected).to.be.gt(0)
    // at 1e18 scaling every one of those increments truncated to zero and this was 0
    expect(paid).to.be.gt(expected.mul(99).div(100))
  })

  // H-01: a fee on transfer staking token delivers less than `amount`.
  it('H-01: credits what the pool received, not what was requested', async () => {
    const stakingToken = await deployContract(wallet, TestFeeToken, [expandTo18Decimals(1_000_000)])
    const rewardsToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])

    const pool = await deployContract(wallet, StakingRewards, [
      wallet.address,
      rewardsToken.address,
      stakingToken.address,
      wallet.address,
      0,
      REWARDS_DURATION,
      0,
      0,
    ])

    const amount = expandTo18Decimals(100)
    await stakingToken.transfer(staker.address, amount)
    const sent = await stakingToken.balanceOf(staker.address)
    await stakingToken.connect(staker).approve(pool.address, sent)
    await pool.connect(staker).stake(sent)

    const held = await stakingToken.balanceOf(pool.address)
    expect(held).to.be.lt(sent)
    // the credit matches the pool balance, so the last withdrawal cannot fail for want of funds
    expect(await pool.balanceOf(staker.address)).to.eq(held)
    expect(await pool.totalSupply()).to.eq(held)

    await pool.connect(staker).withdraw(held)
    expect(await stakingToken.balanceOf(pool.address)).to.eq(0)
  })

  // M-02: an account with many lots must still be able to reach an unlocked one.
  it('M-02: withdrawFrom reaches a single lot by index', async () => {
    const stakingToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
    const rewardsToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])

    const pool = await deployContract(wallet, StakingRewards, [
      wallet.address,
      rewardsToken.address,
      stakingToken.address,
      wallet.address,
      0,
      REWARDS_DURATION,
      0,
      0,
    ])

    const each = expandTo18Decimals(10)
    await stakingToken.transfer(staker.address, each.mul(3))
    await stakingToken.connect(staker).approve(pool.address, each.mul(3))
    for (let i = 0; i < 3; i++) await pool.connect(staker).stake(each)

    expect(await pool.liveLots(staker.address)).to.eq(3)

    // reach the middle lot directly, leaving the ones around it untouched
    await pool.connect(staker).withdrawFrom(1, each)
    expect(await stakingToken.balanceOf(staker.address)).to.eq(each)
    expect(await pool.balanceOf(staker.address)).to.eq(each.mul(2))
    expect((await pool.getUserInfoByIndex(staker.address, 1)).amount).to.eq(0)
    expect((await pool.getUserInfoByIndex(staker.address, 0)).amount).to.eq(each)
  })

  // Reuse: exit() does the work in one pass instead of calling withdraw() then getReward(),
  // which settled the accumulator twice, took the reentrancy guard twice and walked the lot
  // array twice.
  describe('reuse', () => {
    let stakingToken: Contract
    let rewardsToken: Contract
    let pool: Contract

    beforeEach(async () => {
      stakingToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
      rewardsToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
      pool = await deployContract(wallet, StakingRewards, [
        wallet.address,
        rewardsToken.address,
        stakingToken.address,
        wallet.address,
        0,
        REWARDS_DURATION,
        0,
        0,
      ])
      const reward = expandTo18Decimals(100)
      await rewardsToken.transfer(pool.address, reward)
      await pool.notifyRewardAmount(reward, 0, REWARDS_DURATION, 0, 0)
    })

    // GAS is pinned because ganache-core's estimateGas under-shoots a call that follows a
    // reward-bearing settle: it estimated 112 599 for a stake whose actual cost was 173 293.
    // That is a ganache bug, not the pool's - real nodes binary-search on execution.
    async function stakeAs(who: any, lots: number, each: any) {
      await stakingToken.transfer(who.address, each.mul(lots))
      await stakingToken.connect(who).approve(pool.address, each.mul(lots))
      for (let i = 0; i < lots; i++) await pool.connect(who).stake(each, GAS)
    }

    it('exit costs less than withdraw plus getReward', async () => {
      const each = expandTo18Decimals(1)
      await stakeAs(staker, 4, each)
      await stakeAs(attacker, 4, each)
      await mineBlock(provider, (await now()) + 3600)

      const exited = await (await pool.connect(staker).exit(GAS)).wait()

      const withdrawn = await (await pool.connect(attacker).withdraw(each.mul(4), GAS)).wait()
      const claimed = await (await pool.connect(attacker).getRewardFor(attacker.address, GAS)).wait()
      const separate = withdrawn.gasUsed.add(claimed.gasUsed)

      expect(exited.gasUsed).to.be.lt(separate)
      // both paths must land in the same place
      expect(await pool.balanceOf(staker.address)).to.eq(0)
      expect(await stakingToken.balanceOf(staker.address)).to.eq(each.mul(4))
      expect(await rewardsToken.balanceOf(staker.address)).to.be.gt(0)
    })

    it('exit leaves locked lots staked and still earning', async () => {
      const locked = await deployContract(wallet, StakingRewards, [
        wallet.address,
        rewardsToken.address,
        stakingToken.address,
        wallet.address,
        0,
        REWARDS_DURATION,
        3600,
        0,
      ])
      const reward = expandTo18Decimals(100)
      await rewardsToken.transfer(locked.address, reward)
      await locked.notifyRewardAmount(reward, 0, REWARDS_DURATION, 3600, 0)

      const each = expandTo18Decimals(1)
      await stakingToken.transfer(staker.address, each.mul(2))
      await stakingToken.connect(staker).approve(locked.address, each.mul(2))
      await locked.connect(staker).stake(each, GAS)
      await mineBlock(provider, (await now()) + 3601)
      await locked.connect(staker).stake(each, GAS) // this one is still locked

      await locked.connect(staker).exit(GAS)

      expect(await stakingToken.balanceOf(staker.address)).to.eq(each) // only the unlocked lot
      expect(await locked.balanceOf(staker.address)).to.eq(each)
      expect(await rewardsToken.balanceOf(staker.address)).to.be.gt(0)
    })
  })

  describe('factory', () => {
    let factory: Contract
    let rewardsToken: Contract
    let stakingToken: Contract

    beforeEach(async () => {
      factory = await deployContract(wallet, StakingRewardsFactory, [])
      rewardsToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
      stakingToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
    })

    // M-01: the index has to describe the epoch that is actually running.
    it('M-01: startEpoch refreshes poolInfo', async () => {
      const short = 60 * 60
      await rewardsToken.approve(factory.address, expandTo18Decimals(20))
      const tx = await factory.deploy(
        stakingToken.address,
        rewardsToken.address,
        expandTo18Decimals(10),
        0,
        short,
        0,
        0
      )
      const receipt = await tx.wait()
      const pool = receipt.events.filter((e: any) => e.event === 'Deployed')[0].args.stakingRewards

      await mineBlock(provider, (await now()) + short + 1)

      const start = (await now()) + 100
      const cap = expandTo18Decimals(500)
      await factory.startEpoch(pool, expandTo18Decimals(10), start, short * 2, short, cap)

      const info = await factory.poolInfo(pool)
      expect(info.epoch).to.eq(2)
      expect(info.rewardsDuration).to.eq(short * 2)
      expect(info.lockDuration).to.eq(short)
      expect(info.startTime).to.eq(start)
      expect(info.maxStakingPower).to.eq(cap)
    })

    // I-01: poolInfo is packed into narrower types, so every value must be bounded before it is
    // written - a truncating cast in the index would make it disagree with the pool.
    it('I-01: startEpoch rejects values the packed index could not hold', async () => {
      const short = 60 * 60
      await rewardsToken.approve(factory.address, expandTo18Decimals(30))
      const receipt = await (
        await factory.deploy(stakingToken.address, rewardsToken.address, expandTo18Decimals(10), 0, short, 0, 0)
      ).wait()
      const pool = receipt.events.filter((e: any) => e.event === 'Deployed')[0].args.stakingRewards
      await mineBlock(provider, (await now()) + short + 1)

      const YEAR = 365 * 24 * 60 * 60
      const amount = expandTo18Decimals(10)

      await expect(factory.startEpoch(pool, amount, 0, YEAR + 1, 0, 0)).to.be.revertedWith(
        'StakingRewardsFactory: bad duration'
      )
      await expect(factory.startEpoch(pool, amount, 0, short, short + 1, 0)).to.be.revertedWith(
        'StakingRewardsFactory: bad duration'
      )
      await expect(
        factory.startEpoch(pool, amount, (await now()) + YEAR + 1000, short, 0, 0)
      ).to.be.revertedWith('StakingRewardsFactory: bad start time')
      await expect(
        factory.startEpoch(pool, amount, 0, short, 0, BigNumber.from(2).pow(128))
      ).to.be.revertedWith('StakingRewardsFactory: bad staking cap')

      // and the value that does fit round-trips through the packed struct unchanged
      const cap = BigNumber.from(2).pow(128).sub(1)
      const start = (await now()) + 50
      await factory.startEpoch(pool, amount, start, YEAR, short, cap)
      const info = await factory.poolInfo(pool)
      expect(info.maxStakingPower).to.eq(cap)
      expect(info.rewardsDuration).to.eq(YEAR)
      expect(info.startTime).to.eq(start)
      expect(info.epoch).to.eq(2)
    })

    // M-03: the fee role is needed for the life of the factory.
    it('M-03: ownership cannot be renounced, and transfers in two steps', async () => {
      await expect(factory.renounceOwnership()).to.be.reverted

      await factory.transferOwnership(staker.address)
      expect(await factory.owner()).to.eq(wallet.address)
      await factory.connect(staker).acceptOwnership()
      expect(await factory.owner()).to.eq(staker.address)
    })

  })
})
