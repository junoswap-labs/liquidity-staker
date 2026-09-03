import chai, { expect } from 'chai'
import { Contract, BigNumber } from 'ethers'
import { solidity, MockProvider, deployContract } from 'ethereum-waffle'

import { mineBlock, expandTo18Decimals, REWARDS_DURATION } from './utils'

import StakingRewardsFactory from '../build/StakingRewardsFactory.json'
import StakingRewardsLens from '../build/StakingRewardsLens.json'
import StakingRewards from '../build/StakingRewards.json'
import TestERC20 from '../build/TestERC20.json'

chai.use(solidity)

// ganache-core's estimateGas under-shoots a stake that follows a reward-bearing settle; that
// is a ganache bug, not the pool's, so the tests pin an explicit limit
const GAS = { gasLimit: 4_000_000 }

const LOCK = 24 * 60 * 60

describe('StakingRewardsLens', () => {
  const provider = new MockProvider({
    ganacheOptions: {
      hardfork: 'istanbul',
      mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
      gasLimit: 9999999,
    },
  })
  const [wallet, staker] = provider.getWallets()

  let factory: Contract
  let lens: Contract
  let rewardsToken: Contract
  let stakingToken: Contract

  const reward = expandTo18Decimals(100)

  beforeEach(async () => {
    factory = await deployContract(wallet, StakingRewardsFactory, [])
    lens = await deployContract(wallet, StakingRewardsLens, [])
    rewardsToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
    stakingToken = await deployContract(wallet, TestERC20, [expandTo18Decimals(1_000_000)])
  })

  async function openPool(cap: BigNumber = BigNumber.from(0)): Promise<Contract> {
    await rewardsToken.approve(factory.address, reward)
    const receipt = await (
      await factory.deploy(
        stakingToken.address,
        rewardsToken.address,
        reward,
        0,
        REWARDS_DURATION,
        LOCK,
        cap
      )
    ).wait()
    const address = receipt.events.filter((e: any) => e.event === 'Deployed')[0].args.stakingRewards
    return new Contract(address, StakingRewards.abi, provider).connect(wallet)
  }

  it('reads a whole pool in one call', async () => {
    const cap = expandTo18Decimals(1000)
    const pool = await openPool(cap)

    const p = await lens.poolState(pool.address)

    expect(p.stakingToken).to.eq(stakingToken.address)
    expect(p.rewardsToken).to.eq(rewardsToken.address)
    expect(p.creator).to.eq(wallet.address)
    expect(p.totalSupply).to.eq(0)
    expect(p.maxStakingPower).to.eq(cap)
    expect(p.remainingStakingPower).to.eq(cap)
    expect(p.rewardsBalance).to.eq(reward)
    expect(p.rewardsDuration).to.eq(REWARDS_DURATION)
    expect(p.lockDuration).to.eq(LOCK)
    expect(p.closed).to.eq(false)
    expect(p.blockTimestamp).to.eq((await provider.getBlock('latest')).timestamp)

    // every field agrees with the pool's own getters
    expect(p.rewardRate).to.eq(await pool.rewardRate())
    expect(p.periodFinish).to.eq(await pool.periodFinish())
    expect(p.rewardForDuration).to.eq(await pool.getRewardForDuration())
  })

  it('reports an uncapped pool as unlimited', async () => {
    const pool = await openPool()
    const p = await lens.poolState(pool.address)
    expect(p.maxStakingPower).to.eq(0)
    expect(p.remainingStakingPower).to.eq(BigNumber.from(2).pow(256).sub(1))
  })

  it('reads a position, its lots and the token side in one call', async () => {
    const pool = await openPool()

    const each = expandTo18Decimals(10)
    await stakingToken.transfer(staker.address, each.mul(3))
    await stakingToken.connect(staker).approve(pool.address, each.mul(3))
    await pool.connect(staker).stake(each, GAS)
    await pool.connect(staker).stake(each, GAS)

    const [p, u, lots] = await lens.state(pool.address, staker.address, 0, 10)

    expect(p.totalSupply).to.eq(each.mul(2))
    expect(u.balance).to.eq(each.mul(2))
    expect(u.lotCount).to.eq(2)
    expect(u.liveLots).to.eq(2)
    expect(u.withdrawable).to.eq(0) // still locked
    expect(u.nextUnlockAt).to.be.gt(0)
    expect(u.stakingBalance).to.eq(each) // the third one, never staked
    expect(u.stakingAllowance).to.eq(each)
    expect(u.earned).to.eq(await pool.earned(staker.address))

    expect(lots.length).to.eq(2)
    expect(lots[0].amount).to.eq(each)
    expect(lots[1].amount).to.eq(each)

    // nextUnlockAt is the earliest lock still standing, never later than any lot's
    expect(u.nextUnlockAt).to.eq(Math.min(Number(lots[0].unlockAt), Number(lots[1].unlockAt)))

    // past the last lock nothing is left locked
    await mineBlock(provider, Math.max(Number(lots[0].unlockAt), Number(lots[1].unlockAt)) + 1)
    const after = await lens.userState(pool.address, staker.address)
    expect(after.withdrawable).to.eq(each.mul(2))
    expect(after.nextUnlockAt).to.eq(0)
  })

  it('skips the lots when asked for none, and clamps a page past the end', async () => {
    const pool = await openPool()
    const amount = expandTo18Decimals(5)
    await stakingToken.transfer(staker.address, amount)
    await stakingToken.connect(staker).approve(pool.address, amount)
    await pool.connect(staker).stake(amount, GAS)

    expect((await lens.state(pool.address, staker.address, 0, 0))[2].length).to.eq(0)
    expect((await lens.state(pool.address, staker.address, 0, 500))[2].length).to.eq(1)
    expect((await lens.state(pool.address, staker.address, 9, 500))[2].length).to.eq(0)
  })

  it('reads every pool of a factory, with the viewer position, in one call', async () => {
    const a = await openPool()
    const b = await openPool()

    const amount = expandTo18Decimals(7)
    await stakingToken.transfer(staker.address, amount)
    await stakingToken.connect(staker).approve(b.address, amount)
    await b.connect(staker).stake(amount, GAS)

    const [total, pools, infos, poolViews, userViews] = await lens.statesByFactory(
      factory.address,
      staker.address,
      0,
      100
    )

    expect(total).to.eq(2)
    expect(pools).to.deep.eq([a.address, b.address])
    expect(infos[0].creator).to.eq(wallet.address)
    expect(infos[0].epoch).to.eq(1)
    expect(infos[1].rewardAmount).to.eq(reward)
    expect(poolViews[0].totalSupply).to.eq(0)
    expect(poolViews[1].totalSupply).to.eq(amount)
    expect(userViews[0].balance).to.eq(0)
    expect(userViews[1].balance).to.eq(amount)
  })

  it('pages, and reports the total so a caller needs no second call', async () => {
    await openPool()
    await openPool()

    const page = await lens.statesByFactory(factory.address, staker.address, 1, 1)
    expect(page.total).to.eq(2)
    expect(page.pools.length).to.eq(1)
    expect(page.pools[0]).to.eq(await factory.pools(1))

    const past = await lens.statesByFactory(factory.address, staker.address, 9, 5)
    expect(past.total).to.eq(2)
    expect(past.pools.length).to.eq(0)
  })

  it('reads the pools one creator opened', async () => {
    const a = await openPool()

    const [total, pools] = await lens.statesByCreator(
      factory.address,
      wallet.address,
      staker.address,
      0,
      100
    )
    expect(total).to.eq(1)
    expect(pools).to.deep.eq([a.address])

    expect((await lens.statesByCreator(factory.address, staker.address, staker.address, 0, 100)).total).to.eq(0)
  })
})
