// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TipEscrow} from "./TipEscrow.sol";

interface IPancakeV3SwapRouter {
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

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

/// Runs against a fork of BSC mainnet: real USDT, real NVDAB, real PancakeSwap v3 router.
/// Needs network access to a BSC RPC.
contract TipEscrowForkTest is Test {
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant NVDAB = 0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436;
    address constant PCS_V3_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    uint24 constant FEE = 500; // 0.05% NVDAB/USDT pool

    TipEscrow escrow;
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.createSelectFork("https://bsc-dataseed.bnbchain.org");
        escrow = new TipEscrow(owner, operator);
        vm.prank(owner);
        escrow.setRouter(PCS_V3_ROUTER, true);
        deal(USDT, alice, 100e18);
        vm.prank(alice);
        IERC20(USDT).approve(address(escrow), type(uint256).max);
    }

    function test_fork_tipFiveDollarsOfNvidiaAndClaim() public {
        bytes memory data = abi.encodeCall(
            IPancakeV3SwapRouter.exactInputSingle,
            (IPancakeV3SwapRouter.ExactInputSingleParams({
                tokenIn: USDT,
                tokenOut: NVDAB,
                fee: FEE,
                recipient: address(escrow),
                deadline: block.timestamp + 300,
                amountIn: 5e18,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            }))
        );

        vm.prank(alice);
        uint256 id = escrow.tipWithSwap(
            USDT, 5e18, NVDAB, PCS_V3_ROUTER, data, 1, keccak256("tg:1"), uint64(block.timestamp + 7 days)
        );
        uint256 amount = escrow.getTip(id).amount;
        emit log_named_decimal_uint("NVDAB escrowed for $5", amount, 18);
        assertGt(amount, 0);
        assertEq(IERC20(USDT).balanceOf(alice), 95e18);

        vm.prank(operator);
        escrow.claim(id, bob);
        assertEq(IERC20(NVDAB).balanceOf(bob), amount);
    }
}
