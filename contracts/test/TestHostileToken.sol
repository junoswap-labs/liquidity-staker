// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// A token that can do everything a KAP-20 committee can do, so the withdrawal path can be
// tested against each of them rather than assumed safe. Every switch is off by default, so it
// behaves as a plain ERC20 until a test turns one on.
contract TestHostileToken is ERC20 {
    bool public paused;
    mapping(address => bool) public blocked;
    // charged to the SENDER on top of `amount`, in basis points. This is the variant that
    // breaks a pool holding exactly what it owes; the variant that deducts from the recipient
    // does not, and is covered by TestFeeToken.
    uint256 public senderFeeBps;

    constructor(uint256 amount) ERC20("Hostile", "HOSTILE") {
        _mint(msg.sender, amount);
    }

    function setPaused(bool v) external {
        paused = v;
    }

    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function setSenderFeeBps(uint256 bps) external {
        senderFeeBps = bps;
    }

    /// @dev stands in for KAP-20 `adminTransfer`: moves a holder's balance without their consent
    function adminTransfer(address from, address to, uint256 amount) external {
        _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        require(!paused, "HOSTILE: paused");
        require(!blocked[from] && !blocked[to], "HOSTILE: blocked");
        super._transfer(from, to, amount);
        if (senderFeeBps > 0) {
            _burn(from, (amount * senderFeeBps) / 10000);
        }
    }
}
