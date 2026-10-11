// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./Mocks.sol";

// Stand-ins for PancakeSwap v3's QuoterV2 and SwapRouter, with the same function signatures.
// Stateless (fixed price, no constructor), so tests can place their code at the real mainnet
// addresses with hardhat_setCode and run the bot's server code unchanged.

uint256 constant PRICE_IN_USDT = 200; // 1 stock token = 200 USDT
uint24 constant LIVE_FEE = 500; // only the 0.05% "pool" exists; other tiers revert like a missing pool

contract MockQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        pure
        returns (uint256 amountOut, uint160, uint32, uint256)
    {
        require(params.fee == LIVE_FEE, "no pool");
        return (params.amountIn / PRICE_IN_USDT, 0, 0, 0);
    }
}

contract MockSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        require(params.fee == LIVE_FEE, "no pool");
        require(block.timestamp <= params.deadline, "Transaction too old");
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn / PRICE_IN_USDT;
        require(amountOut >= params.amountOutMinimum, "Too little received");
        MockERC20(params.tokenOut).mint(params.recipient, amountOut);
    }
}
