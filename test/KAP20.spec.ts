import chai, { expect } from 'chai'
import { Contract } from 'ethers'
import { solidity, MockProvider, deployContract } from 'ethereum-waffle'

import StakingRewards from '../build/StakingRewards.json'
import TestERC20 from '../build/TestERC20.json'
import TestKAP20 from '../build/TestKAP20.json'
import { expandTo18Decimals } from './utils'

chai.use(solidity)

describe('stakingAllowance', () => {
  const provider = new MockProvider({
    ganacheOptions: { hardfork: 'istanbul', mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn', gasLimit: 9999999 },
  })
  const [wallet] = provider.getWallets()
  const amount = expandTo18Decimals(7)

  async function staker(stakingToken: Contract) {
    return deployContract(wallet, StakingRewards, [wallet.address, stakingToken.address, stakingToken.address, wallet.address, 0, 60 * 60 * 24 * 60, 0, 0])
  }

  it('reads ERC20 allowance()', async () => {
    const token = await deployContract(wallet, TestERC20, [expandTo18Decimals(100)])
    const stakingRewards = await staker(token)
    await token.approve(stakingRewards.address, amount)
    expect(await stakingRewards.stakingAllowance(wallet.address)).to.eq(amount)
  })

  it('falls back to KAP-20 allowances()', async () => {
    const token = await deployContract(wallet, TestKAP20, [])
    expect(token.interface.functions).to.not.have.property('allowance(address,address)')
    const stakingRewards = await staker(token)
    await token.approve(stakingRewards.address, amount)
    expect(await stakingRewards.stakingAllowance(wallet.address)).to.eq(amount)
  })

  it('reverts on a token with neither', async () => {
    const stakingRewards = await staker({ address: wallet.address } as Contract)
    await expect(stakingRewards.stakingAllowance(wallet.address)).to.be.reverted
  })
})
