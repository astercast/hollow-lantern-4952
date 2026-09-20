// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MuseDogRoyaltySplitter
/// @notice Permanent ERC-2981 royalty recipient for the Muse Dogs collection (MUSEDOGS).
///         Every resale royalty payment is split, on arrival, into three fixed shares:
///           - 10% to Mikey's Bankr address, in raw ETH
///           - 40% to the holder-rewards vault
///           - 50% to the autonomous fee engine (buyback-burn + liquidity)
/// @dev No owner, no admin keys, nothing changeable — the split is baked in forever.
///      DUST: Mikey's and the vault's shares are computed with bps floor math, so a
///      tiny remainder can be left over on odd totals. The fee engine receives
///      `balance - mikeyShare - vaultShare` (the whole remainder), which means all
///      rounding dust flows to the fee engine and no wei can ever be stranded in
///      this contract.
///      DRAFT — not audited, not deployed. Independent audit required before mainnet.
contract MuseDogRoyaltySplitter is ReentrancyGuard {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @notice Basis-point denominator for the split math.
    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Mikey's share: 10% (1000 bps) of every royalty payment, in raw ETH.
    uint256 public constant MIKEY_BPS = 1_000;
    /// @notice Holder-rewards vault share: 40% (4000 bps) of every royalty payment.
    uint256 public constant VAULT_BPS = 4_000;

    // -------------------------------------------------------------------------
    // State (immutable)
    // -------------------------------------------------------------------------

    /// @notice Mikey's Bankr address. Receives 10% of royalties in raw ETH.
    address public immutable mikey;
    /// @notice Holder-rewards vault. Receives 40% of royalties.
    address public immutable rewardsVault;
    /// @notice Autonomous fee engine. Receives the remaining 50% plus all dust.
    address public immutable feeEngine;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    /// @dev A zero recipient would burn ETH (or deadlock it); reject at deploy.
    error ZeroAddress();

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted on every split: exact amounts each party received.
    event RoyaltySplit(
        uint256 total,
        uint256 mikeyShare,
        uint256 vaultShare,
        uint256 engineShare
    );

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param mikey_        Mikey's Bankr address (10% recipient).
    /// @param rewardsVault_ Holder-rewards vault (40% recipient).
    /// @param feeEngine_    Autonomous fee engine (50% + dust recipient).
    constructor(address mikey_, address rewardsVault_, address feeEngine_) {
        if (mikey_ == address(0) || rewardsVault_ == address(0) || feeEngine_ == address(0)) {
            revert ZeroAddress();
        }
        mikey = mikey_;
        rewardsVault = rewardsVault_;
        feeEngine = feeEngine_;
    }

    // -------------------------------------------------------------------------
    // Split
    // -------------------------------------------------------------------------

    /// @notice Split any ETH this contract receives: 10% to Mikey, 40% to the
    ///         rewards vault, 50% (plus all rounding dust) to the fee engine.
    /// @dev nonReentrant: payouts push ETH to external addresses, so a malicious
    ///      recipient re-entering this function cannot double-collect.
    receive() external payable nonReentrant {
        uint256 total = msg.value;
        uint256 mikeyShare = (total * MIKEY_BPS) / BPS_DENOMINATOR;
        uint256 vaultShare = (total * VAULT_BPS) / BPS_DENOMINATOR;
        // Remainder math: the engine gets everything left after the two floored
        // shares, so the three payouts always sum to exactly `total` and the
        // contract never holds a balance.
        uint256 engineShare = total - mikeyShare - vaultShare;

        _send(mikey, mikeyShare);
        _send(rewardsVault, vaultShare);
        _send(feeEngine, engineShare);

        emit RoyaltySplit(total, mikeyShare, vaultShare, engineShare);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    /// @dev Push ETH with a low-level call; revert if the transfer fails.
    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "splitter: ETH transfer failed");
    }
}
