// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Swaps at a fixed rate (out = in * rateNum / rateDen). Can be told to use only part of the
///      input, or to send the output somewhere other than the caller.
contract MockRouter {
    uint256 public rateNum = 1;
    uint256 public rateDen = 1;

    function setRate(uint256 num, uint256 den) external {
        rateNum = num;
        rateDen = den;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 useIn, address to) external {
        uint256 used = useIn == 0 ? amountIn : useIn;
        IERC20(tokenIn).transferFrom(msg.sender, address(this), used);
        MockERC20(tokenOut).mint(to, (used * rateNum) / rateDen);
    }

    function fail() external pure {
        revert("router says no");
    }
}
