// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TipEscrow} from "./TipEscrow.sol";
import {MockERC20, MockRouter} from "./mocks/Mocks.sol";

contract TipEscrowTest is Test {
    TipEscrow escrow;
    MockERC20 usdt;
    MockERC20 stock;
    MockERC20 otherStock;
    MockRouter router;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address alice = makeAddr("alice"); // sender
    address bob = makeAddr("bob"); // recipient wallet
    address mallory = makeAddr("mallory");

    bytes32 constant RECIPIENT = keccak256("tg:12345:salt");

    function setUp() public {
        escrow = new TipEscrow(owner, operator);
        usdt = new MockERC20("Tether", "USDT");
        stock = new MockERC20("NVIDIA (bStocks)", "NVDAB");
        otherStock = new MockERC20("Tesla (bStocks)", "TSLAB");
        router = new MockRouter();
        router.setRate(1, 200); // 1 stock = 200 USDT

        vm.prank(owner);
        escrow.setRouter(address(router), true);

        usdt.mint(alice, 1_000e18);
        stock.mint(alice, 10e18);
        vm.startPrank(alice);
        usdt.approve(address(escrow), type(uint256).max);
        stock.approve(address(escrow), type(uint256).max);
        vm.stopPrank();
    }

    function _expiry() internal view returns (uint64) {
        return uint64(block.timestamp + 7 days);
    }

    function _swapData(uint256 amountIn, uint256 useIn, address to) internal view returns (bytes memory) {
        return abi.encodeCall(MockRouter.swap, (address(usdt), address(stock), amountIn, useIn, to));
    }

    function _tipWithSwap(uint256 amountIn) internal returns (uint256) {
        vm.prank(alice);
        return escrow.tipWithSwap(
            address(usdt), amountIn, address(stock), address(router),
            _swapData(amountIn, 0, address(escrow)), 0, RECIPIENT, _expiry()
        );
    }

    // ------------------------------------------------------------------ tip

    function test_tip_holdsTokens() public {
        vm.prank(alice);
        uint256 id = escrow.tip(address(stock), 1e18, RECIPIENT, _expiry());

        TipEscrow.Tip memory t = escrow.getTip(id);
        assertEq(t.sender, alice);
        assertEq(t.token, address(stock));
        assertEq(t.amount, 1e18);
        assertEq(t.recipientHash, RECIPIENT);
        assertEq(stock.balanceOf(address(escrow)), 1e18);
        assertEq(escrow.tipCount(), 1);
    }

    function test_tip_rejectsZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(TipEscrow.ZeroAmount.selector);
        escrow.tip(address(stock), 0, RECIPIENT, _expiry());
    }

    function test_tip_rejectsBadExpiry() public {
        vm.startPrank(alice);
        vm.expectRevert(TipEscrow.BadExpiry.selector);
        escrow.tip(address(stock), 1e18, RECIPIENT, uint64(block.timestamp + 10 minutes));
        vm.expectRevert(TipEscrow.BadExpiry.selector);
        escrow.tip(address(stock), 1e18, RECIPIENT, uint64(block.timestamp + 91 days));
        vm.stopPrank();
    }

    // ---------------------------------------------------------- tipWithSwap

    function test_tipWithSwap_escrowsOutput() public {
        uint256 id = _tipWithSwap(5e18);

        TipEscrow.Tip memory t = escrow.getTip(id);
        assertEq(t.token, address(stock));
        assertEq(t.amount, 5e18 / 200);
        assertEq(stock.balanceOf(address(escrow)), 5e18 / 200);
        assertEq(usdt.balanceOf(alice), 995e18);
        assertEq(usdt.allowance(address(escrow), address(router)), 0);
    }

    function test_tipWithSwap_refundsUnusedInput() public {
        vm.prank(alice);
        escrow.tipWithSwap(
            address(usdt), 10e18, address(stock), address(router),
            _swapData(10e18, 4e18, address(escrow)), 0, RECIPIENT, _expiry()
        );
        assertEq(usdt.balanceOf(alice), 996e18);
        assertEq(usdt.balanceOf(address(escrow)), 0);
    }

    function test_tipWithSwap_rejectsUnknownRouter() public {
        MockRouter rogue = new MockRouter();
        vm.prank(alice);
        vm.expectRevert(TipEscrow.RouterNotAllowed.selector);
        escrow.tipWithSwap(
            address(usdt), 5e18, address(stock), address(rogue),
            _swapData(5e18, 0, address(escrow)), 0, RECIPIENT, _expiry()
        );
    }

    function test_tipWithSwap_enforcesMinOut() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TipEscrow.InsufficientOutput.selector, 5e18 / 200, 1e18));
        escrow.tipWithSwap(
            address(usdt), 5e18, address(stock), address(router),
            _swapData(5e18, 0, address(escrow)), 1e18, RECIPIENT, _expiry()
        );
    }

    function test_tipWithSwap_outputSentElsewhereCountsAsZero() public {
        vm.prank(alice);
        vm.expectRevert(TipEscrow.ZeroAmount.selector);
        escrow.tipWithSwap(
            address(usdt), 5e18, address(stock), address(router),
            _swapData(5e18, 0, mallory), 0, RECIPIENT, _expiry()
        );
    }

    function test_tipWithSwap_bubblesRouterFailure() public {
        vm.prank(alice);
        vm.expectRevert();
        escrow.tipWithSwap(
            address(usdt), 5e18, address(stock), address(router),
            abi.encodeCall(MockRouter.fail, ()), 0, RECIPIENT, _expiry()
        );
    }

    function test_tipWithSwap_rejectsSameToken() public {
        vm.prank(alice);
        vm.expectRevert(TipEscrow.SameToken.selector);
        escrow.tipWithSwap(
            address(stock), 1e18, address(stock), address(router), "", 0, RECIPIENT, _expiry()
        );
    }

    /// Other people's escrowed stock must not be spendable through a swap.
    function test_tipWithSwap_cannotTouchOtherTips() public {
        vm.prank(alice);
        escrow.tip(address(stock), 2e18, RECIPIENT, _expiry());

        // Mallory tries to swap 1 stock in, while the escrow holds Alice's 2.
        stock.mint(mallory, 1e18);
        vm.startPrank(mallory);
        stock.approve(address(escrow), type(uint256).max);
        bytes memory data =
            abi.encodeCall(MockRouter.swap, (address(stock), address(otherStock), 3e18, 0, address(escrow)));
        vm.expectRevert(); // router can only pull the 1e18 approved
        escrow.tipWithSwap(
            address(stock), 1e18, address(otherStock), address(router), data, 0, RECIPIENT, _expiry()
        );
        vm.stopPrank();
        assertEq(stock.balanceOf(address(escrow)), 2e18);
    }

    // ---------------------------------------------------------------- claim

    function test_claim_operatorPaysOut() public {
        uint256 id = _tipWithSwap(5e18);
        vm.prank(operator);
        escrow.claim(id, bob);
        assertEq(stock.balanceOf(bob), 5e18 / 200);
        assertTrue(escrow.getTip(id).settled);
    }

    function test_claim_onlyOperator() public {
        uint256 id = _tipWithSwap(5e18);
        vm.prank(mallory);
        vm.expectRevert(TipEscrow.NotOperator.selector);
        escrow.claim(id, mallory);
    }

    function test_claim_notTwice() public {
        uint256 id = _tipWithSwap(5e18);
        vm.startPrank(operator);
        escrow.claim(id, bob);
        vm.expectRevert(TipEscrow.AlreadySettled.selector);
        escrow.claim(id, bob);
        vm.stopPrank();
    }

    function test_claim_notAfterExpiry() public {
        uint256 id = _tipWithSwap(5e18);
        vm.warp(block.timestamp + 8 days);
        vm.prank(operator);
        vm.expectRevert(TipEscrow.Expired.selector);
        escrow.claim(id, bob);
    }

    // --------------------------------------------------------------- refund

    function test_refund_anyoneAfterExpiry() public {
        uint256 id = _tipWithSwap(5e18);
        vm.warp(block.timestamp + 8 days);
        vm.prank(mallory);
        escrow.refund(id);
        assertEq(stock.balanceOf(alice), 10e18 + 5e18 / 200);
        assertEq(stock.balanceOf(mallory), 0);
    }

    function test_refund_notBeforeExpiry() public {
        uint256 id = _tipWithSwap(5e18);
        vm.prank(alice);
        vm.expectRevert(TipEscrow.NotExpired.selector);
        escrow.refund(id);
    }

    function test_refund_operatorAnytime() public {
        uint256 id = _tipWithSwap(5e18);
        vm.prank(operator);
        escrow.refund(id);
        assertEq(stock.balanceOf(alice), 10e18 + 5e18 / 200);
    }

    function test_refund_afterClaimFails() public {
        uint256 id = _tipWithSwap(5e18);
        vm.prank(operator);
        escrow.claim(id, bob);
        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(TipEscrow.AlreadySettled.selector);
        escrow.refund(id);
    }

    // ---------------------------------------------------------------- admin

    function test_admin_onlyOwner() public {
        vm.startPrank(mallory);
        vm.expectRevert();
        escrow.setOperator(mallory);
        vm.expectRevert();
        escrow.setRouter(mallory, true);
        vm.stopPrank();
    }

    function test_admin_ownerCanReplaceOperator() public {
        uint256 id = _tipWithSwap(5e18);
        address newOp = makeAddr("newOp");
        vm.prank(owner);
        escrow.setOperator(newOp);

        vm.prank(operator);
        vm.expectRevert(TipEscrow.NotOperator.selector);
        escrow.claim(id, bob);

        vm.prank(newOp);
        escrow.claim(id, bob);
        assertEq(stock.balanceOf(bob), 5e18 / 200);
    }
}
