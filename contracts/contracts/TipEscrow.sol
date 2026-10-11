// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TipEscrow
/// @notice Holds tokenized-stock tips until the bot's operator wallet releases them to the
///         recipient's wallet, or returns them to the sender after expiry.
/// @dev Trust model: the operator decides who receives a tip. The owner can replace the operator.
contract TipEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Tip {
        address sender;
        uint64 expiry;
        bool settled;
        address token;
        uint256 amount;
        bytes32 recipientHash;
    }

    uint64 public constant MIN_DURATION = 1 hours;
    uint64 public constant MAX_DURATION = 90 days;

    address public operator;
    mapping(address router => bool) public isRouter;
    Tip[] internal _tips;

    event Tipped(
        uint256 indexed tipId,
        address indexed sender,
        address indexed token,
        uint256 amount,
        bytes32 recipientHash,
        uint64 expiry
    );
    event Claimed(uint256 indexed tipId, address indexed to);
    event Refunded(uint256 indexed tipId, address indexed sender);
    event OperatorSet(address operator);
    event RouterSet(address router, bool allowed);

    error NotOperator();
    error BadExpiry();
    error ZeroAmount();
    error RouterNotAllowed();
    error SameToken();
    error SwapFailed(bytes reason);
    error InsufficientOutput(uint256 received, uint256 minOut);
    error AlreadySettled();
    error Expired();
    error NotExpired();
    error ZeroAddress();

    constructor(address owner_, address operator_) Ownable(owner_) {
        _setOperator(operator_);
    }

    // ---------------------------------------------------------------- tipping

    /// @notice Tip a token the sender already holds.
    function tip(address token, uint256 amount, bytes32 recipientHash, uint64 expiry)
        external
        nonReentrant
        returns (uint256 tipId)
    {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        return _record(token, received, recipientHash, expiry);
    }

    /// @notice Pay in `tokenIn` (e.g. USDT); the escrow swaps it to `tokenOut` (the stock) through an
    ///         allow-listed router and holds the result. `swapData` must send the output to this contract.
    function tipWithSwap(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        address router,
        bytes calldata swapData,
        uint256 minOut,
        bytes32 recipientHash,
        uint64 expiry
    ) external nonReentrant returns (uint256 tipId) {
        if (!isRouter[router]) revert RouterNotAllowed();
        if (tokenIn == tokenOut) revert SameToken();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 received = _swap(IERC20(tokenIn), amountIn, IERC20(tokenOut), router, swapData);
        if (received < minOut) revert InsufficientOutput(received, minOut);

        return _record(tokenOut, received, recipientHash, expiry);
    }

    // ------------------------------------------------------------- settlement

    /// @notice Release a tip to the recipient's wallet. Operator only, before expiry.
    function claim(uint256 tipId, address to) external nonReentrant {
        if (msg.sender != operator) revert NotOperator();
        if (to == address(0)) revert ZeroAddress();
        Tip storage t = _tips[tipId];
        if (t.settled) revert AlreadySettled();
        if (block.timestamp >= t.expiry) revert Expired();
        t.settled = true;
        IERC20(t.token).safeTransfer(to, t.amount);
        emit Claimed(tipId, to);
    }

    /// @notice Return a tip to its sender. Anyone after expiry; the operator at any time.
    function refund(uint256 tipId) external nonReentrant {
        Tip storage t = _tips[tipId];
        if (t.settled) revert AlreadySettled();
        if (msg.sender != operator && block.timestamp < t.expiry) revert NotExpired();
        t.settled = true;
        IERC20(t.token).safeTransfer(t.sender, t.amount);
        emit Refunded(tipId, t.sender);
    }

    // ------------------------------------------------------------------ views

    function getTip(uint256 tipId) external view returns (Tip memory) {
        return _tips[tipId];
    }

    function tipCount() external view returns (uint256) {
        return _tips.length;
    }

    // ------------------------------------------------------------------ admin

    function setOperator(address operator_) external onlyOwner {
        _setOperator(operator_);
    }

    function setRouter(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        isRouter[router] = allowed;
        emit RouterSet(router, allowed);
    }

    // --------------------------------------------------------------- internal

    function _setOperator(address operator_) internal {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    /// @dev Swaps `amountIn` through `router`, returns any unused input to the caller, and reports
    ///      how much `outToken` this contract gained. Approval is capped at `amountIn` and reset
    ///      afterwards, so the router can never reach other tips' balances.
    function _swap(IERC20 inToken, uint256 amountIn, IERC20 outToken, address router, bytes calldata swapData)
        internal
        returns (uint256 received)
    {
        uint256 inBefore = inToken.balanceOf(address(this));
        uint256 outBefore = outToken.balanceOf(address(this));

        inToken.forceApprove(router, amountIn);
        (bool ok, bytes memory ret) = router.call(swapData);
        if (!ok) revert SwapFailed(ret);
        inToken.forceApprove(router, 0);

        received = outToken.balanceOf(address(this)) - outBefore;

        uint256 spent = inBefore - inToken.balanceOf(address(this));
        if (spent < amountIn) inToken.safeTransfer(msg.sender, amountIn - spent);
    }

    function _record(address token, uint256 amount, bytes32 recipientHash, uint64 expiry)
        internal
        returns (uint256 tipId)
    {
        if (amount == 0) revert ZeroAmount();
        if (expiry < block.timestamp + MIN_DURATION || expiry > block.timestamp + MAX_DURATION) {
            revert BadExpiry();
        }
        tipId = _tips.length;
        _tips.push(Tip(msg.sender, expiry, false, token, amount, recipientHash));
        emit Tipped(tipId, msg.sender, token, amount, recipientHash, expiry);
    }
}
