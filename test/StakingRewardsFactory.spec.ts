import chai, { expect } from 'chai'
import { Contract, BigNumber } from 'ethers'
import { solidity, MockProvider, createFixtureLoader } from 'ethereum-waffle'

import { stakingRewardsFactoryFixture } from './fixtures'
import { expandTo18Decimals, mineBlock, REWARDS_DURATION } from './utils'

import StakingRewards from '../build/StakingRewards.json'

chai.use(solidity)

const LOCK = 7 * 24 * 60 * 60 // 7 days, in seconds

describe('StakingRewardsFactory', () => {
  const provider = new MockProvider({
    ganacheOptions: {
      hardfork: 'istanbul',
      mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
      gasLimit: 9999999,
    },
  })
  const [wallet, wallet1] = provider.getWallets()
  const loadFixture = createFixtureLoader([wallet], provider)

  let rewardsToken: Contract
  let genesis: number
  let rewardAmounts: BigNumber[]
  let stakingRewardsFactory: Contract
  let stakingTokens: Contract[]

  beforeEach('load fixture', async () => {
    const fixture = await loadFixture(stakingRewardsFactoryFixture)
    rewardsToken = fixture.rewardsToken
    genesis = fixture.genesis
    rewardAmounts = fixture.rewardAmounts
    stakingRewardsFactory = fixture.stakingRewardsFactory
    stakingTokens = fixture.stakingTokens
  })

  // deploy a pool from `from`, funding it with `reward` of `reward token`
  async function deployPool(
    stakingToken: Contract,
    reward: BigNumber,
    lockDuration: number = 0,
    from = wallet,
    token: Contract = rewardsToken,
    rewardsDuration: number = REWARDS_DURATION,
    startTime: number = 0,
    cap: BigNumber | number = 0
  ): Promise<Contract> {
    await token.connect(from).approve(stakingRewardsFactory.address, reward)
    await stakingRewardsFactory.connect(from).deploy(stakingToken.address, token.address, reward, startTime, rewardsDuration, lockDuration, cap)
    const pool = await stakingRewardsFactory.pools((await stakingRewardsFactory.poolsLength()).sub(1))
    return new Contract(pool, StakingRewards.abi, provider)
  }

  describe('#deploy', () => {
    it('funds the pool from the caller', async () => {
      const pool = await deployPool(stakingTokens[1], rewardAmounts[1])
      expect(await rewardsToken.balanceOf(pool.address)).to.eq(rewardAmounts[1])
      expect(await rewardsToken.balanceOf(stakingRewardsFactory.address)).to.eq(0)
    })

    it('is permissionless', async () => {
      await rewardsToken.transfer(wallet1.address, rewardAmounts[0])
      const pool = await deployPool(stakingTokens[0], rewardAmounts[0], 0, wallet1)
      expect(await rewardsToken.balanceOf(pool.address)).to.eq(rewardAmounts[0])
      expect(await stakingRewardsFactory.poolsByCreator(wallet1.address, 0)).to.eq(pool.address)
    })

    it('stores pool info and emits Deployed', async () => {
      await rewardsToken.approve(stakingRewardsFactory.address, 10000)
      const receipt = await (
        await stakingRewardsFactory.deploy(stakingTokens[1].address, rewardsToken.address, 10000, 0, REWARDS_DURATION, LOCK, 0)
      ).wait()
      const pool = await stakingRewardsFactory.pools(0)

      // Deployed comes first, so an indexer sees the pool exist before its first epoch starts
      const names = receipt.logs
        .map((log: any) => {
          try {
            return stakingRewardsFactory.interface.parseLog(log).name
          } catch {
            return null
          }
        })
        .filter((n: string | null) => n !== null)
      expect(names).to.deep.eq(['Deployed', 'EpochStarted'])

      const event = stakingRewardsFactory.interface.parseLog(
        receipt.logs.filter((log: any) => log.address === stakingRewardsFactory.address)[0]
      )
      expect(event.name).to.eq('Deployed')
      expect(event.args.stakingToken).to.eq(stakingTokens[1].address)
      expect(event.args.rewardsToken).to.eq(rewardsToken.address)
      expect(event.args.stakingRewards).to.eq(pool)
      expect(event.args.deployer).to.eq(wallet.address)
      expect(event.args.rewardAmount).to.eq(10000)
      expect(event.args.startTime).to.eq(0)
      expect(event.args.rewardsDuration).to.eq(REWARDS_DURATION)
      expect(event.args.lockDuration).to.eq(LOCK)
      expect(event.args.maxStakingPower).to.eq(0)

      // the index is packed, so read it by name rather than by position
      const info = await stakingRewardsFactory.poolInfo(pool)
      const { creator, stakingToken, rewardsToken: token, rewardAmount, startTime, rewardsDuration, lockDuration } = info
      const cap = info.maxStakingPower
      expect(creator).to.eq(wallet.address)
      expect(stakingToken).to.eq(stakingTokens[1].address)
      expect(token).to.eq(rewardsToken.address)
      expect(rewardAmount).to.eq(10000)
      expect(startTime).to.eq(0)
      expect(rewardsDuration).to.eq(REWARDS_DURATION)
      expect(lockDuration).to.eq(LOCK)
      expect(cap).to.eq(0)
      expect(await stakingRewardsFactory.poolsByCreatorLength(wallet.address)).to.eq(1)
      expect(await stakingRewardsFactory.poolsByCreator(wallet.address, 0)).to.eq(pool)
    })

    it('deployed staking rewards has correct parameters', async () => {
      const pool = await deployPool(stakingTokens[1], rewardAmounts[1], LOCK)
      expect(await pool.rewardsDistribution()).to.eq(stakingRewardsFactory.address)
      expect(await pool.stakingToken()).to.eq(stakingTokens[1].address)
      expect(await pool.rewardsToken()).to.eq(rewardsToken.address)
      expect(await pool.lockDuration()).to.eq(LOCK)
    })

    it('allows many pools for the same staking token, with different reward tokens', async () => {
      const a = await deployPool(stakingTokens[1], rewardAmounts[1])
      const b = await deployPool(stakingTokens[1], expandTo18Decimals(5), 0, wallet, stakingTokens[2])
      expect(a.address).to.not.eq(b.address)
      expect(await stakingRewardsFactory.poolsLength()).to.eq(2)
      expect(await b.rewardsToken()).to.eq(stakingTokens[2].address)
    })

    it('honours a custom rewards duration', async () => {
      const short = 7 * 24 * 60 * 60
      const pool = await deployPool(stakingTokens[1], rewardAmounts[1], 0, wallet, rewardsToken, short)
      expect(await pool.rewardsDuration()).to.eq(short)

      // rewardRate is per second scaled by PRECISION = 1e36
      expect(await pool.rewardRate()).to.eq(rewardAmounts[1].mul(BigNumber.from(10).pow(36)).div(short))
      expect(await pool.periodFinish()).to.eq((await provider.getBlock('latest')).timestamp + short)
    })

    it('rejects a zero rewards duration', async () => {
      await rewardsToken.approve(stakingRewardsFactory.address, 10000)
      await expect(stakingRewardsFactory.deploy(stakingTokens[1].address, rewardsToken.address, 10000, 0, 0, 0, 0)).to.be
        .reverted
    })

    it('rejects a zero reward token or amount', async () => {
      await expect(
        stakingRewardsFactory.deploy(stakingTokens[1].address, `0x${'0'.repeat(40)}`, 10000, 0, REWARDS_DURATION, 0, 0)
      ).to.be.revertedWith('StakingRewardsFactory: rewards token is zero')
      await expect(
        stakingRewardsFactory.deploy(stakingTokens[1].address, rewardsToken.address, 0, 0, REWARDS_DURATION, 0, 0)
      ).to.be.revertedWith('StakingRewardsFactory: reward amount is zero')
    })

    it('rejects a lock longer than the epoch', async () => {
      await rewardsToken.approve(stakingRewardsFactory.address, 10000)
      await expect(
        stakingRewardsFactory.deploy(stakingTokens[1].address, rewardsToken.address, 10000, 0, LOCK, LOCK + 1, 0)
      ).to.be.revertedWith('Lock longer than epoch')
    })

    it('fails without an allowance for the rewards', async () => {
      await expect(stakingRewardsFactory.deploy(stakingTokens[1].address, rewardsToken.address, 10000, 0, REWARDS_DURATION, 0, 0)).to.be
        .reverted
    })
  })

  describe('service fee', () => {
    it('is off by default', async () => {
      expect(await stakingRewardsFactory.feeAmount()).to.eq(0)
      expect(await stakingRewardsFactory.feeToken()).to.eq(`0x${'0'.repeat(40)}`)
      const pool = await deployPool(stakingTokens[1], rewardAmounts[1])
      expect(await rewardsToken.balanceOf(pool.address)).to.eq(rewardAmounts[1])
    })

    it('charges the deployer once set', async () => {
      const fee = expandTo18Decimals(2)
      await stakingRewardsFactory.setServiceFee(stakingTokens[3].address, fee, wallet1.address)

      // reward transfer succeeds, fee transfer has no allowance yet
      await rewardsToken.approve(stakingRewardsFactory.address, rewardAmounts[1])
      await expect(
        stakingRewardsFactory.deploy(stakingTokens[1].address, rewardsToken.address, rewardAmounts[1], 0, REWARDS_DURATION, 0, 0)
      ).to.be.reverted

      await stakingTokens[3].approve(stakingRewardsFactory.address, fee)
      const pool = await deployPool(stakingTokens[1], rewardAmounts[1])
      expect(await stakingTokens[3].balanceOf(wallet1.address)).to.eq(fee)
      expect(await rewardsToken.balanceOf(pool.address)).to.eq(rewardAmounts[1])
    })

    it('can be turned back off', async () => {
      await stakingRewardsFactory.setServiceFee(stakingTokens[3].address, expandTo18Decimals(2), wallet1.address)
      await stakingRewardsFactory.setServiceFee(`0x${'0'.repeat(40)}`, 0, `0x${'0'.repeat(40)}`)
      await deployPool(stakingTokens[1], rewardAmounts[1])
      expect(await stakingTokens[3].balanceOf(wallet1.address)).to.eq(0)
    })

    it('rejects an incomplete fee, and non owners', async () => {
      await expect(
        stakingRewardsFactory.setServiceFee(`0x${'0'.repeat(40)}`, 1, wallet1.address)
      ).to.be.revertedWith('StakingRewardsFactory: incomplete fee')
      await expect(
        stakingRewardsFactory.connect(wallet1).setServiceFee(stakingTokens[3].address, 1, wallet1.address)
      ).to.be.reverted
    })
  })

  describe('first epoch', () => {
    it('deploy starts it, no second call needed', async () => {
      const pool = await deployPool(stakingTokens[1], rewardAmounts[1])
      expect(await pool.rewardRate()).to.be.gt(0)
      expect(await pool.periodFinish()).to.be.gt(0)
      expect((await stakingRewardsFactory.poolInfo(pool.address)).epoch).to.eq(1)
      expect(await rewardsToken.balanceOf(pool.address)).to.eq(rewardAmounts[1])
    })

    it('emits EpochStarted for epoch 1', async () => {
      await rewardsToken.approve(stakingRewardsFactory.address, 10000)
      await expect(
        stakingRewardsFactory.deploy(stakingTokens[1].address, rewardsToken.address, 10000, 0, REWARDS_DURATION, 0, 0)
      ).to.emit(stakingRewardsFactory, 'EpochStarted')
    })
  })

  describe('startAt', () => {
    it('accrues from startTime, not from the notify transaction', async () => {
      const start = (await provider.getBlock('latest')).timestamp + 24 * 60 * 60
      const pool = (await deployPool(stakingTokens[1], rewardAmounts[1], 0, wallet, rewardsToken, REWARDS_DURATION, start))
        .connect(wallet)

      expect(await pool.lastUpdateTime()).to.eq(start)
      expect(await pool.periodFinish()).to.eq(start + REWARDS_DURATION)

      // staking before the start earns nothing while waiting
      const stake = expandTo18Decimals(1)
      await stakingTokens[1].approve(pool.address, stake)
      await pool.stake(stake)
      await mineBlock(provider, start - 60)
      expect(await pool.earned(wallet.address)).to.eq(0)

      await mineBlock(provider, start + 3600)
      expect(await pool.earned(wallet.address)).to.be.gt(0)
    })
  })

  describe('#claimAll', () => {
    it('harvests several pools in one transaction, paying the caller', async () => {
      const a = (await deployPool(stakingTokens[1], rewardAmounts[1])).connect(wallet)
      const b = (await deployPool(stakingTokens[2], rewardAmounts[2])).connect(wallet)
      const stake = expandTo18Decimals(1)
      for (const [pool, token] of [[a, stakingTokens[1]], [b, stakingTokens[2]]] as [Contract, Contract][]) {
        await token.approve(pool.address, stake)
        await pool.stake(stake)
      }

      await mineBlock(provider, genesis + 7 * 24 * 60 * 60)

      const before = await rewardsToken.balanceOf(wallet.address)
      await stakingRewardsFactory.claimAll([a.address, b.address])
      expect(await rewardsToken.balanceOf(wallet.address)).to.be.gt(before)
      expect(await a.earned(wallet.address)).to.eq(0)
      expect(await b.earned(wallet.address)).to.eq(0)
    })

    it('rejects an address that is not a pool', async () => {
      await expect(stakingRewardsFactory.claimAll([wallet.address])).to.be.revertedWith(
        'StakingRewardsFactory: not deployed'
      )
    })
  })

  describe('#recoverUnallocatedRewards', () => {
    it('returns the rewards nobody could earn, to the creator, after the period', async () => {
      const short = 7 * 24 * 60 * 60
      const pool = await deployPool(stakingTokens[1], rewardAmounts[1], 0, wallet, rewardsToken, short)


      // nobody ever stakes. leftovers stay put while another epoch is still possible
      await expect(pool.connect(wallet).recoverUnallocatedRewards()).to.be.revertedWith('Pool not closed')
      await expect(pool.connect(wallet).close()).to.be.revertedWith('Epoch not over')

      await mineBlock(provider, Number(await pool.periodFinish()) + 1)
      await pool.connect(wallet).close()
      const before = await rewardsToken.balanceOf(wallet.address)
      await pool.connect(wallet).recoverUnallocatedRewards()
      const recovered = (await rewardsToken.balanceOf(wallet.address)).sub(before)
      expect(rewardAmounts[1].sub(recovered)).to.be.lte(1000)
      expect(await rewardsToken.balanceOf(pool.address)).to.be.lte(1000)
    })


    it('refuses to close a live epoch', async () => {
      const pool = (await deployPool(stakingTokens[1], rewardAmounts[1])).connect(wallet)
      const stake = expandTo18Decimals(1)
      await stakingTokens[1].approve(pool.address, stake)
      await pool.stake(stake)

      await expect(pool.close()).to.be.revertedWith('Epoch not over')
    })

    it('is creator only', async () => {
      const pool = await deployPool(stakingTokens[1], rewardAmounts[1])
      expect(await pool.creator()).to.eq(wallet.address)
      await expect(pool.connect(wallet1).recoverUnallocatedRewards()).to.be.revertedWith('Not the creator')
      await expect(pool.connect(wallet1).close()).to.be.revertedWith('Not the creator')
    })
  })


  describe('#startEpoch', () => {
    const short = 7 * 24 * 60 * 60

    async function firstEpoch(lock = 0): Promise<Contract> {
      const pool = await deployPool(stakingTokens[1], rewardAmounts[1], lock, wallet, rewardsToken, short)
      return pool.connect(wallet)
    }

    it('runs a second epoch on the same pool, with its own schedule', async () => {
      const pool = await firstEpoch()
      expect((await stakingRewardsFactory.poolInfo(pool.address)).epoch).to.eq(1)

      await expect(
        stakingRewardsFactory.startEpoch(pool.address, rewardAmounts[1], 0, short, 0, 0)
      ).to.be.revertedWith('StakingRewardsFactory: epoch not over')

      const end = Number(await pool.periodFinish())
      await mineBlock(provider, end + 1)

      const start = end + 3600
      const longer = 2 * short
      await rewardsToken.approve(stakingRewardsFactory.address, rewardAmounts[2])
      await expect(stakingRewardsFactory.startEpoch(pool.address, rewardAmounts[2], start, longer, 60, 0))
        .to.emit(stakingRewardsFactory, 'EpochStarted')
        .withArgs(pool.address, 2, rewardAmounts[2], start, longer, 60, 0)

      expect(await pool.startTime()).to.eq(start)
      expect(await pool.rewardsDuration()).to.eq(longer)
      expect(await pool.lockDuration()).to.eq(60)
      expect(await pool.periodFinish()).to.eq(start + longer)
      expect((await stakingRewardsFactory.poolInfo(pool.address)).epoch).to.eq(2)
    })

    it('keeps rewards earned in the previous epoch', async () => {
      const pool = await firstEpoch()
      const stake = expandTo18Decimals(1)
      await stakingTokens[1].approve(pool.address, stake)
      await pool.stake(stake)

      const end = Number(await pool.periodFinish())
      await mineBlock(provider, end + 1)
      const earnedBefore = await pool.earned(wallet.address)
      expect(earnedBefore).to.be.gt(0)

      await rewardsToken.approve(stakingRewardsFactory.address, rewardAmounts[2])
      await stakingRewardsFactory.startEpoch(pool.address, rewardAmounts[2], 0, short, 0, 0)
      expect(await pool.earned(wallet.address)).to.be.gte(earnedBefore)
    })

    it('is creator only, and refuses a closed pool', async () => {
      const pool = await firstEpoch()
      const end = Number(await pool.periodFinish())
      await mineBlock(provider, end + 1)

      await expect(
        stakingRewardsFactory.connect(wallet1).startEpoch(pool.address, 1, 0, short, 0, 0)
      ).to.be.revertedWith('StakingRewardsFactory: not the creator')

      await pool.close()
      await rewardsToken.approve(stakingRewardsFactory.address, rewardAmounts[2])
      await expect(stakingRewardsFactory.startEpoch(pool.address, rewardAmounts[2], 0, short, 0, 0)).to.be.revertedWith(
        'Pool closed'
      )
    })

    it('refuses a lock longer than the epoch', async () => {
      const pool = await firstEpoch()
      const end = Number(await pool.periodFinish())
      await mineBlock(provider, end + 1)
      await rewardsToken.approve(stakingRewardsFactory.address, rewardAmounts[2])
      await expect(
        stakingRewardsFactory.startEpoch(pool.address, rewardAmounts[2], 0, short, short + 1, 0)
        // the factory bounds it first, before narrowing it into the packed index; the pool
        // enforces the same rule again in notifyRewardAmount
      ).to.be.revertedWith('StakingRewardsFactory: bad duration')
    })

    it('never locks a stake past the end of its epoch', async () => {
      const pool = await firstEpoch(short) // lock as long as the epoch itself
      const end = BigNumber.from(await pool.periodFinish())

      // stake late in the epoch: a full lock would run past the end, so it is capped
      await mineBlock(provider, end.toNumber() - 600)
      const stake = expandTo18Decimals(1)
      await stakingTokens[1].approve(pool.address, stake)
      await pool.stake(stake)
      expect((await pool.getUserInfoByIndex(wallet.address, 0)).unlockAt).to.eq(end)

      await mineBlock(provider, end.toNumber() + 1)
      await pool.withdraw(stake)
    })
  })


  describe('deposit lots', () => {
    const short = 7 * 24 * 60 * 60
    const lock = 24 * 60 * 60

    async function started(): Promise<Contract> {
      const pool = await deployPool(stakingTokens[1], rewardAmounts[1], lock, wallet, rewardsToken, short)
      return pool.connect(wallet)
    }

    async function stake(pool: Contract, amount: BigNumber) {
      await stakingTokens[1].approve(pool.address, amount)
      await pool.stake(amount)
    }

    it('records one lot per stake, and indexes stay stable', async () => {
      const pool = await started()
      const first = expandTo18Decimals(1)
      const second = expandTo18Decimals(2)

      await stake(pool, first)
      const firstLot = await pool.getUserInfoByIndex(wallet.address, 0)
      await mineBlock(provider, firstLot.unlockAt - lock + 3600)
      await stake(pool, second)

      expect(await pool.totalUserStakedIndex(wallet.address)).to.eq(2)
      const lots = await pool.getUserInfos(wallet.address)
      expect(lots.length).to.eq(2)
      expect(lots[0].amount).to.eq(first)
      expect(lots[1].amount).to.eq(second)
      // the second stake did NOT push the first lot's unlock out
      expect(lots[0].unlockAt).to.eq(firstLot.unlockAt)
      expect(lots[1].unlockAt).to.be.gt(lots[0].unlockAt)
      expect(lots[1].stakedAt).to.be.gt(lots[0].stakedAt)

      const page = await pool.getUserInfosPaged(wallet.address, 1, 10)
      expect(page.length).to.eq(1)
      expect(page[0].amount).to.eq(second)
    })

    it('unlocks lot by lot, oldest first', async () => {
      const pool = await started()
      const first = expandTo18Decimals(1)
      const second = expandTo18Decimals(2)

      await stake(pool, first)
      const firstUnlock = Number((await pool.getUserInfoByIndex(wallet.address, 0)).unlockAt)
      await mineBlock(provider, firstUnlock - 3600)
      await stake(pool, second)

      expect(await pool.withdrawableOf(wallet.address)).to.eq(0)
      expect(await pool.nextUnlockAt(wallet.address)).to.eq(firstUnlock)
      await expect(pool.withdraw(first)).to.be.revertedWith('Still locked')

      // first lot unlocked, second not
      await mineBlock(provider, firstUnlock + 1)
      expect(await pool.withdrawableOf(wallet.address)).to.eq(first)
      await expect(pool.withdraw(first.add(1))).to.be.revertedWith('Still locked')

      // exit takes only what is unlocked and leaves the rest staked
      await pool.exit()
      expect(await pool.balanceOf(wallet.address)).to.eq(second)
      expect((await pool.getUserInfos(wallet.address))[0].amount).to.eq(0)
      expect((await pool.getUserInfos(wallet.address))[1].amount).to.eq(second)

      const secondUnlock = Number((await pool.getUserInfoByIndex(wallet.address, 1)).unlockAt)
      await mineBlock(provider, secondUnlock + 1)
      await pool.withdraw(second)
      expect(await pool.balanceOf(wallet.address)).to.eq(0)
      expect(await pool.totalSupply()).to.eq(0)
    })

    it('splits a withdrawal across lots', async () => {
      const pool = await started()
      const each = expandTo18Decimals(1)
      await stake(pool, each)
      await stake(pool, each)

      const unlock = Number((await pool.getUserInfoByIndex(wallet.address, 1)).unlockAt)
      await mineBlock(provider, unlock + 1)

      await pool.withdraw(each.add(each.div(2)))
      const lots = await pool.getUserInfos(wallet.address)
      expect(lots[0].amount).to.eq(0)
      expect(lots[1].amount).to.eq(each.div(2))
      expect(await pool.balanceOf(wallet.address)).to.eq(each.div(2))
    })
  })

  describe('lock duration', () => {
    it('blocks withdraw until the timestamp elapses, then allows it', async () => {
      const stakingToken = stakingTokens[1]
      const pool = (await deployPool(stakingToken, rewardAmounts[1], LOCK)).connect(wallet)
      const stake = expandTo18Decimals(1)

      await stakingToken.approve(pool.address, stake)
      await pool.stake(stake)
      const unlock = BigNumber.from((await pool.getUserInfoByIndex(wallet.address, 0)).unlockAt)

      await expect(pool.withdraw(stake)).to.be.revertedWith('Still locked')

      await mineBlock(provider, unlock.toNumber())
      await pool.withdraw(stake)
      expect(await pool.balanceOf(wallet.address)).to.eq(0)
    })
  })
})
