pragma solidity ^0.5.16;

// minimal KAP-20 shape for tests: `allowances` getter, no ERC20 `allowance`
contract TestKAP20 {
    mapping(address => mapping(address => uint256)) public allowances;

    function approve(address spender, uint256 amount) external returns (bool) {
        allowances[msg.sender][spender] = amount;
        return true;
    }
}
