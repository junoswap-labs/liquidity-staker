// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title KAP20
/// @notice Reads a token allowance on KUB Chain, where the KAP-20 standard and ERC20 disagree.
/// @dev KAP-20 tokens expose the public mapping getter `allowances(address,address)`, and some
/// of them, KUSDT included, have no ERC20 `allowance(address,address)` at all. Verified on KUB
/// mainnet KUSDT 0x7d984C24d2499D840eB3b7016077164e15E5faA6, where `allowance(a,b)` reverts and
/// `allowances(a,b)` returns the value. Both are read with staticcall so a missing selector is
/// a failed call rather than a revert of the caller.
library KAP20 {
    bytes4 private constant ALLOWANCE = 0xdd62ed3e; // allowance(address,address)
    bytes4 private constant ALLOWANCES = 0x55b6ed5c; // allowances(address,address)

    /// @notice remaining amount `spender` may pull from `owner`.
    /// @dev Tries the ERC20 getter first, then the KAP-20 one. Reverts only when the token has
    /// neither, which means it is not a token this system can work with.
    function allowanceOf(address token, address owner, address spender) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(ALLOWANCE, owner, spender));
        if (!ok || data.length < 32) {
            (ok, data) = token.staticcall(abi.encodeWithSelector(ALLOWANCES, owner, spender));
        }
        require(ok && data.length >= 32, "KAP20: no allowance getter");
        return abi.decode(data, (uint256));
    }
}
