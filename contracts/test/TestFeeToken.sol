// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// test token that burns 1% of every transfer, to prove the pool credits what it received
contract TestFeeToken is ERC20 {
    uint256 public constant FEE_BPS = 100;

    constructor(uint256 amount) ERC20("Fee", "FEE") {
        _mint(msg.sender, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 fee = (amount * FEE_BPS) / 10000;
        super._transfer(from, to, amount - fee);
        if (fee > 0) _burn(from, fee);
    }
}
