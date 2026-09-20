// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MuseDogsFeeSplitter
/// @notice Permanent ERC-2981 royalty recipient for the Muse Dogs collection.
///         Every 5% resale royalty paid to this contract is divided, on
///         process(), into four fixed legs:
///           - 10% -> Mikey's Bankr address, in raw ETH (pushed on process())
///           - 40% -> holder RewardsVault (pushed on process())
///           - 25% -> MDOG buyback-and-burn leg (escrowed; forwarded by owner)
///           - 25% -> MDOG/ETH liquidity leg, destined for the dead address
///                    (escrowed; forwarded by owner)
/// @dev WHY THE DEX LEGS ARE NOT AUTONOMOUS (read this before "improving" it):
///      A fully-autonomous on-chain swap for the buyback and LP legs would have
///      to hard-code a DEX router/quoter for Robinhood Chain. That surface
///      cannot be pinned safely at build time: router addresses change, pools
///      may be thin, and a stale or wrong router turns the splitter into an
///      MEV / loss machine with no human in the loop. Shipping an unaudited
///      autonomous swapper would be strictly riskier than the alternative.
///      Instead the two DEX-dependent legs accumulate in audited escrow
///      buckets (buybackPending / liquidityPending) that ONLY the owner
///      (the project Safe multisig) can forward, ONLY up to the bucketed
///      amount, with an event per forward. The multisig executes the
///      buyback-burn and the LP-tothe-dead-address steps transparently
///      (or points the forward at a future, separately-audited swapper
///      contract). No ETH can leave except through the four legs; no ETH can
///      ever be stranded: remainder dust from bps floor math flows to the
///      liquidity bucket via remainder arithmetic (liquidityShare =
///      newFunds - mikey - rewards - buyback), so the four legs always sum to
///      exactly the processed amount.
///
///      TRUST ASSUMPTIONS (explicit):
///        1. The owner is the project Safe multisig. It is trusted to forward
///           the buyback/liquidity legs to the right destinations. It CANNOT
///           steal the mikey/vault legs (immutable recipients) and CANNOT
///           forward more than each bucket holds.
///        2. mikeyBankr and rewardsVault are set at construction and IMMUTABLE.
///           If either were wrong, its leg would be misdirected forever — the
///           deploy-time addresses must be triple-checked (see NOTES.md).
///        3. Push transfers use low-level call with all gas. If a recipient
///           reverts (e.g. a contract vault with a failing receive), the push
///           fails OPEN: the amount stays in its pending bucket and anyone can
///           retry via claimMikey()/claimRewards(). Funds are never locked by
///           a reverting recipient.
///        4. Anyone can call process() once the threshold is crossed — it is a
///           permissionless keeper. There is nothing to front-run: the split
///           math is fixed and recipients are fixed.
///        5. Direct ETH donations are split like royalties on the next
///           process() call. Do not send ETH here expecting it back.
///
///      No delegatecall, no selfdestruct, no owner mint/upgrade powers.
contract MuseDogsFeeSplitter is Ownable2Step, ReentrancyGuard {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @notice Basis-point denominator.
    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Mikey's Bankr leg: 10% (1000 bps) of processed royalties.
    uint256 public constant MIKEY_BPS = 1_000;
    /// @notice Holder-rewards vault leg: 40% (4000 bps).
    uint256 public constant REWARDS_BPS = 4_000;
    /// @notice MDOG buyback-and-burn leg: 25% (2500 bps), escrowed.
    uint256 public constant BUYBACK_BPS = 2_500;
    /// @notice MDOG/ETH liquidity leg: 25% (2500 bps) + all dust, escrowed.
    uint256 public constant LIQUIDITY_BPS = 2_500;

    // -------------------------------------------------------------------------
    // Immutable recipients (set at construction, never changeable)
    // -------------------------------------------------------------------------

    /// @notice Mikey's Bankr address. Receives 10% of royalties in raw ETH.
    address payable public immutable mikeyBankr;
    /// @notice Holder rewards vault (MuseDogRewards). Receives 40%.
    address payable public immutable rewardsVault;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice Minimum NEW funds (wei) required for process() to run.
    ///         Owner-tunable; always > 0.
    uint256 public processThreshold;

    /// @notice Escrow buckets. ETH here is already assigned to its leg;
    ///         process() never re-splits escrowed funds (it only splits
    ///         balance MINUS these buckets — see process()).
    uint256 public mikeyPending;
    uint256 public rewardsPending;
    uint256 public buybackPending;
    uint256 public liquidityPending;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error NotAContract(address account);
    error ZeroThreshold();
    error BelowThreshold(uint256 threshold, uint256 newFunds);
    error NothingPending();
    error InsufficientPending(uint256 requested, uint256 available);
    error TransferFailed();

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice ETH arrived (royalty payment or donation).
    event RoyaltyReceived(address indexed from, uint256 amount);
    /// @notice A process() run split newFunds into the four legs.
    event Processed(
        uint256 newFunds,
        uint256 mikeyShare,
        uint256 rewardsShare,
        uint256 buybackShare,
        uint256 liquidityShare,
        bool mikeyPushed,
        bool rewardsPushed
    );
    /// @notice Pending mikey funds were pushed (via process() or claimMikey()).
    event MikeyPaid(uint256 amount);
    /// @notice Pending vault funds were pushed (via process() or claimRewards()).
    event RewardsPaid(uint256 amount);
    /// @notice Owner forwarded buyback-leg ETH toward the burn path.
    event BuybackForwarded(address indexed destination, uint256 amount);
    /// @notice Owner forwarded liquidity-leg ETH toward the LP path.
    event LiquidityForwarded(address indexed destination, uint256 amount);
    /// @notice Owner changed the process threshold.
    event ThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param mikeyBankr_   Mikey's Bankr address (10% leg). Immutable.
    /// @param rewardsVault_ Holder rewards vault (40% leg). Immutable.
    /// @param initialOwner  Project Safe multisig. Ownable2Step: it must call
    ///                      acceptOwnership() to complete the transfer.
    /// @param initialThreshold Minimum new wei per process() call. Must be > 0.
    constructor(
        address payable mikeyBankr_,
        address payable rewardsVault_,
        address initialOwner,
        uint256 initialThreshold
    ) Ownable(initialOwner) {
        if (
            mikeyBankr_ == address(0) ||
            rewardsVault_ == address(0) ||
            initialOwner == address(0)
        ) revert ZeroAddress();
        // The vault leg is pushed automatically on every process(): it must be
        // a contract that can receive ETH, not an EOA typo. (mikeyBankr is
        // intentionally unchecked — it is expected to be an EOA.)
        if (address(rewardsVault_).code.length == 0) {
            revert NotAContract(address(rewardsVault_));
        }
        if (initialThreshold == 0) revert ZeroThreshold();
        mikeyBankr = mikeyBankr_;
        rewardsVault = rewardsVault_;
        processThreshold = initialThreshold;
        emit ThresholdUpdated(0, initialThreshold);
    }

    // -------------------------------------------------------------------------
    // Receiving royalties
    // -------------------------------------------------------------------------

    /// @notice Accept royalty ETH (and, if anyone insists, donations).
    /// @dev Splitting happens in process(), not here: receive() does no
    ///      external calls, so it cannot be griefed by a reverting recipient.
    receive() external payable {
        emit RoyaltyReceived(msg.sender, msg.value);
    }

    // -------------------------------------------------------------------------
    // Permissionless keeper: split newly arrived funds
    // -------------------------------------------------------------------------

    /// @notice Split all NEW funds (balance minus already-escrowed buckets)
    ///         into the four legs. Callable by ANYONE once newFunds >=
    ///         processThreshold. The 10%/40% legs are pushed immediately
    ///         (failing open into their pending buckets on recipient revert);
    ///         the 25%/25% DEX legs stay escrowed for owner forwarding.
    /// @dev CRITICAL ACCOUNTING: only `balance - totalPending()` is split.
    ///      Escrowed funds are never re-split, so a second process() call can
    ///      never dilute the buyback/liquidity buckets. Checks-effects-
    ///      interactions: buckets are credited before any external call.
    ///      nonReentrant: recipients are external addresses.
    function process() external nonReentrant {
        uint256 balance = address(this).balance;
        uint256 accounted = _totalPending();
        // Invariant: balance >= accounted always holds, because every wei that
        // leaves does so through a bucket decrement of the same size.
        uint256 newFunds = balance - accounted;
        if (newFunds < processThreshold) {
            revert BelowThreshold(processThreshold, newFunds);
        }

        uint256 mikeyShare = (newFunds * MIKEY_BPS) / BPS_DENOMINATOR;
        uint256 rewardsShare = (newFunds * REWARDS_BPS) / BPS_DENOMINATOR;
        uint256 buybackShare = (newFunds * BUYBACK_BPS) / BPS_DENOMINATOR;
        // Remainder math: dust from the three floored divisions lands in the
        // liquidity leg, so the four legs sum to EXACTLY newFunds and no wei
        // can ever be stranded outside the buckets.
        uint256 liquidityShare = newFunds - mikeyShare - rewardsShare - buybackShare;

        // ---- effects ----
        mikeyPending += mikeyShare;
        rewardsPending += rewardsShare;
        buybackPending += buybackShare;
        liquidityPending += liquidityShare;

        // ---- interactions: push the two direct legs, failing OPEN ----
        // Skips (and does not emit for) legs with a zero pending balance, so
        // no zero-amount Paid events are ever emitted.
        bool mikeyPushed = mikeyPending > 0 ? _tryPush(mikeyBankr, mikeyPending) : true;
        if (mikeyPending > 0 && mikeyPushed) {
            emit MikeyPaid(mikeyPending);
            mikeyPending = 0;
        }
        bool rewardsPushed = rewardsPending > 0 ? _tryPush(rewardsVault, rewardsPending) : true;
        if (rewardsPending > 0 && rewardsPushed) {
            emit RewardsPaid(rewardsPending);
            rewardsPending = 0;
        }

        emit Processed(
            newFunds,
            mikeyShare,
            rewardsShare,
            buybackShare,
            liquidityShare,
            mikeyPushed,
            rewardsPushed
        );
    }

    /// @notice Retry a failed Mikey push. Permissionless; funds can only ever
    ///         go to the immutable mikeyBankr address.
    function claimMikey() external nonReentrant {
        uint256 amount = mikeyPending;
        if (amount == 0) revert NothingPending();
        mikeyPending = 0; // effects before interaction
        (bool ok, ) = mikeyBankr.call{value: amount}("");
        if (!ok) {
            // Restore on failure so the funds are not lost.
            mikeyPending = amount;
            revert TransferFailed();
        }
        emit MikeyPaid(amount);
    }

    /// @notice Retry a failed rewards-vault push. Permissionless; funds can
    ///         only ever go to the immutable rewardsVault address.
    function claimRewards() external nonReentrant {
        uint256 amount = rewardsPending;
        if (amount == 0) revert NothingPending();
        rewardsPending = 0; // effects before interaction
        (bool ok, ) = rewardsVault.call{value: amount}("");
        if (!ok) {
            rewardsPending = amount;
            revert TransferFailed();
        }
        emit RewardsPaid(amount);
    }

    // -------------------------------------------------------------------------
    // Owner forwarding: the two DEX-dependent legs (multisig executes)
    // -------------------------------------------------------------------------

    /// @notice Forward buyback-leg ETH toward the MDOG buyback-and-burn
    ///         execution. Owner (multisig) only, capped at the bucket balance.
    /// @dev The destination is the multisig's choice: itself (to run the swap
    ///      manually and transparently) or a future audited swapper contract.
    ///      Reverts (rather than escrowing) on transfer failure so the owner
    ///      can retry with a corrected destination — no funds move on failure.
    function forwardBuyback(address payable destination, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (destination == address(0)) revert ZeroAddress();
        if (amount == 0) revert NothingPending();
        if (amount > buybackPending) {
            revert InsufficientPending(amount, buybackPending);
        }
        buybackPending -= amount; // effects before interaction
        (bool ok, ) = destination.call{value: amount}("");
        if (!ok) {
            buybackPending += amount;
            revert TransferFailed();
        }
        emit BuybackForwarded(destination, amount);
    }

    /// @notice Forward liquidity-leg ETH toward the MDOG/ETH LP step whose
    ///         LP tokens are minted to the dead address
    ///         (0x000000000000000000000000000000000000dEaD).
    /// @dev Same safety shape as forwardBuyback.
    function forwardLiquidity(address payable destination, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (destination == address(0)) revert ZeroAddress();
        if (amount == 0) revert NothingPending();
        if (amount > liquidityPending) {
            revert InsufficientPending(amount, liquidityPending);
        }
        liquidityPending -= amount; // effects before interaction
        (bool ok, ) = destination.call{value: amount}("");
        if (!ok) {
            liquidityPending += amount;
            revert TransferFailed();
        }
        emit LiquidityForwarded(destination, amount);
    }

    /// @notice Tune the process() threshold. Always > 0. Emits an event.
    function setProcessThreshold(uint256 newThreshold) external onlyOwner {
        if (newThreshold == 0) revert ZeroThreshold();
        uint256 oldThreshold = processThreshold;
        processThreshold = newThreshold;
        emit ThresholdUpdated(oldThreshold, newThreshold);
    }

    // -------------------------------------------------------------------------
    // Views + internals
    // -------------------------------------------------------------------------

    /// @notice Sum of the four escrow buckets (wei already assigned to legs).
    function totalPending() external view returns (uint256) {
        return _totalPending();
    }

    function _totalPending() internal view returns (uint256) {
        return mikeyPending + rewardsPending + buybackPending + liquidityPending;
    }

    /// @dev Low-level push that FAILS OPEN: returns false instead of
    ///      reverting, so one reverting recipient can never block process().
    function _tryPush(address payable to, uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        (bool ok, ) = to.call{value: amount}("");
        return ok;
    }
}
