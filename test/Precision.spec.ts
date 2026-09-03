import chai, { expect } from 'chai'
import { Contract, BigNumber } from 'ethers'
import { solidity, MockProvider, deployContract } from 'ethereum-waffle'

import { mineBlock } from './utils'

import StakingRewards from '../build/StakingRewards.json'
import TestERC20Decimals from '../build/TestERC20Decimals.json'

chai.use(solidity)

const DURATION = 7 * 24 * 60 * 60
// The accumulator truncates twice: once dividing the scaled rate by totalSupply, once
// multiplying it back by a balance. That leaves at most ~totalSupply / 1e18 base units behind,
// plus a couple from the rate itself. Scaling rewardRate by PRECISION = 1e36 is what keeps it to
// that instead of losing whole seconds of emissions; the bound below is the pre-1e36 one, kept
// deliberately loose so it still fails loudly if the scaling is ever reduced.
const MAX_DUST = 10
function maxDust(totalStaked: BigNumber): BigNumber {
  return totalStaked.div(BigNumber.from(10).pow(18)).add(MAX_DUST)
}

// 0 and 2 are the pathological ends, 6 is KUSDT, 8 is KBTC/KETH style, 18 is everything else
const DECIMALS = [0, 2, 6, 8, 18]

describe('precision across token decimals', () => {
  const provider = new MockProvider({
    ganacheOptions: {
      hardfork: 'istanbul',
      mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
      gasLimit: 9999999,
    },
  })
  const [wallet, staker] = provider.getWallets()

  function units(amount: number, decimals: number): BigNumber {
    return BigNumber.from(amount).mul(BigNumber.from(10).pow(decimals))
  }

  for (const decimals of DECIMALS) {
    it(`${decimals} decimals: stake in equals stake out, rewards land within dust`, async () => {
      const supply = units(1_000_000, decimals)
      const stakingToken = await deployContract(wallet, TestERC20Decimals, [supply, decimals])
      const rewardsToken = await deployContract(wallet, TestERC20Decimals, [supply, decimals])
      expect(await stakingToken.decimals()).to.eq(decimals)

      const stakingRewards = await deployContract(wallet, StakingRewards, [
        wallet.address, // rewardsDistribution
        rewardsToken.address,
        stakingToken.address,
        wallet.address, // creator
        0,
        DURATION,
        0,
        0,
      ])

      // a deliberately awkward stake: not a round number of whole tokens
      const stake = units(1234, decimals).add(decimals > 0 ? 567 : 0)
      await stakingToken.transfer(staker.address, stake)
      await stakingToken.connect(staker).approve(stakingRewards.address, stake)
      await stakingRewards.connect(staker).stake(stake)
      expect(await stakingToken.balanceOf(staker.address)).to.eq(0)

      // a reward budget that does not divide evenly by the duration
      const reward = units(1000, decimals).add(decimals > 0 ? 1 : 0)
      await rewardsToken.transfer(stakingRewards.address, reward)
      await stakingRewards.notifyRewardAmount(reward, 0, DURATION, 0, 0)

      const endTime = BigNumber.from(await stakingRewards.periodFinish())
      await mineBlock(provider, endTime.add(1).toNumber())

      await stakingRewards.connect(staker).exit()

      // staked tokens come back exactly, never rounded
      expect(await stakingToken.balanceOf(staker.address)).to.eq(stake)
      expect(await stakingToken.balanceOf(stakingRewards.address)).to.eq(0)

      // the sole staker earns the whole budget bar dust
      const paid = await rewardsToken.balanceOf(staker.address)
      expect(paid).to.be.lte(reward)
      expect(reward.sub(paid)).to.be.lte(maxDust(stake))
    })
  }

  it('splits between two stakers without losing more than dust', async () => {
    const decimals = 6 // KUSDT, the worst realistic case
    const supply = units(1_000_000, decimals)
    const stakingToken = await deployContract(wallet, TestERC20Decimals, [supply, decimals])
    const rewardsToken = await deployContract(wallet, TestERC20Decimals, [supply, decimals])

    const stakingRewards = await deployContract(wallet, StakingRewards, [
      wallet.address,
      rewardsToken.address,
      stakingToken.address,
      wallet.address,
      0,
      DURATION,
      0,
      0,
    ])

    // 1:3 split, on purpose not a clean fraction of the budget
    const small = units(1, decimals)
    const large = units(3, decimals)
    await stakingToken.connect(wallet).approve(stakingRewards.address, small)
    await stakingRewards.connect(wallet).stake(small)
    await stakingToken.transfer(staker.address, large)
    await stakingToken.connect(staker).approve(stakingRewards.address, large)
    await stakingRewards.connect(staker).stake(large)

    const reward = units(1000, decimals).add(7)
    await rewardsToken.transfer(stakingRewards.address, reward)
    await stakingRewards.notifyRewardAmount(reward, 0, DURATION, 0, 0)

    const endTime = BigNumber.from(await stakingRewards.periodFinish())
    await mineBlock(provider, endTime.add(1).toNumber())

    const walletBefore = await rewardsToken.balanceOf(wallet.address)
    const stakerBefore = await rewardsToken.balanceOf(staker.address)
    await stakingRewards.connect(wallet).exit()
    await stakingRewards.connect(staker).exit()
    // exit returns the stake in the same token for wallet, so measure rewards net of it
    const walletPaid = (await rewardsToken.balanceOf(wallet.address)).sub(walletBefore)
    const stakerPaid = (await rewardsToken.balanceOf(staker.address)).sub(stakerBefore)

    // stakes returned exactly, and the pool is left holding only dust
    expect(await stakingToken.balanceOf(stakingRewards.address)).to.eq(0)
    expect(await stakingToken.balanceOf(staker.address)).to.eq(large)
    expect(await rewardsToken.balanceOf(stakingRewards.address)).to.be.lte(maxDust(small.add(large)))

    // 1:3 split holds, and nothing beyond dust went missing
    expect(stakerPaid.sub(walletPaid.mul(3)).abs()).to.be.lte(maxDust(small.add(large)))
    expect(reward.sub(walletPaid.add(stakerPaid))).to.be.lte(maxDust(small.add(large)))
  })
})
