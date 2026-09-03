// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// test token with a configurable number of decimals, for precision tests
contract TestERC20Decimals is ERC20 {
    uint8 private immutable _decimals;

    constructor(uint256 amount, uint8 tokenDecimals) ERC20("Test", "TEST") {
        _decimals = tokenDecimals;
        _mint(msg.sender, amount);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
