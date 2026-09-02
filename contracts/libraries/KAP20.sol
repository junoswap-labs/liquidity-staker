pragma solidity ^0.5.16;

// KAP-20 (KUB Chain) tokens expose the public mapping getter `allowances(address,address)`.
// Some of them, KUSDT included, have NO ERC20 `allowance(address,address)` at all.
// Verified on KUB mainnet KUSDT 0x7d984C24d2499D840eB3b7016077164e15E5faA6:
// `allowance(a,b)` reverts, `allowances(a,b)` returns the value.
library KAP20 {
    bytes4 private constant ALLOWANCE = 0xdd62ed3e; // allowance(address,address)
    bytes4 private constant ALLOWANCES = 0x55b6ed5c; // allowances(address,address)

    // remaining amount `spender` may pull from `owner`, ERC20 first, KAP-20 as fallback
    function allowanceOf(address token, address owner, address spender) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(ALLOWANCE, owner, spender));
        if (!ok || data.length < 32) {
            (ok, data) = token.staticcall(abi.encodeWithSelector(ALLOWANCES, owner, spender));
        }
        require(ok && data.length >= 32, "KAP20: no allowance getter");
        return abi.decode(data, (uint256));
    }
}
