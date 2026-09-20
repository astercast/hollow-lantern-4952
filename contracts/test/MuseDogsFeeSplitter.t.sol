// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MuseDogsFeeSplitter} from "../src/MuseDogsFeeSplitter.sol";
import {MuseDogRewards} from "../src/MuseDogRewards.sol";

/// @notice Test suite for MuseDogsFeeSplitter: split math, threshold gating,
///         the critical no-re-split accounting invariant, fail-open pushes,
///         owner forwarding of the DEX legs, and reentrancy.
contract MuseDogsFeeSplitterTest is Test {
    MuseDogsFeeSplitter splitter;

    address payable internal mikey = payable(address(0xD06));
    address payable internal vault; // real MuseDogRewards, deployed in setUp
    address internal owner = address(0xBEEF);
    uint256 internal threshold = 0.1 ether;

    function setUp() public {
        vault = payable(address(new MuseDogRewards(owner)));
        splitter = new MuseDogsFeeSplitter(mikey, vault, owner, threshold);
    }

    // -------------------------------------------------------------------------
    // Split math
    // -------------------------------------------------------------------------

    function test_ProcessSplitsTenFortyTwentyFiveTwentyFive() public {
        vm.deal(address(splitter), 1 ether);
        uint256 mikeyBefore = mikey.balance;
        uint256 vaultBefore = vault.balance;

        vm.prank(address(0xEE1)); // anyone can call
        splitter.process();

        assertEq(mikey.balance - mikeyBefore, 0.1 ether, "mikey 10%");
        assertEq(vault.balance - vaultBefore, 0.4 ether, "vault 40%");
        assertEq(splitter.buybackPending(), 0.25 ether, "buyback 25%");
        assertEq(splitter.liquidityPending(), 0.25 ether, "liquidity 25%");
        assertEq(splitter.mikeyPending(), 0);
        assertEq(splitter.rewardsPending(), 0);
        assertEq(address(splitter).balance, 0.5 ether, "escrow remains");
    }

    function test_DustFlowsToLiquidityLeg() public {
        MuseDogsFeeSplitter tiny = new MuseDogsFeeSplitter(mikey, vault, owner, 1 wei);
        vm.deal(address(tiny), 10_001 wei);
        tiny.process();
        // floor(10001*1000/10000)=1000, floor(10001*4000/10000)=4000,
        // floor(10001*2500/10000)=2500, remainder 2501 -> liquidity.
        assertEq(mikey.balance, 1000 wei);
        assertEq(vault.balance, 4000 wei);
        assertEq(tiny.buybackPending(), 2500 wei);
        assertEq(tiny.liquidityPending(), 2501 wei);
        assertEq(tiny.totalPending(), 5001 wei);
        assertEq(address(tiny).balance, 5001 wei);
    }

    function test_ProcessBelowThresholdReverts() public {
        vm.deal(address(splitter), 0.05 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                MuseDogsFeeSplitter.BelowThreshold.selector,
                threshold,
                0.05 ether
            )
        );
        splitter.process();
    }

    /// @notice THE critical accounting invariant: process() must only split
    ///         NEW funds. A second process() with no new deposits reverts;
    ///         with new deposits it splits ONLY the new funds, never diluting
    ///         the buyback/liquidity escrows.
    function test_ProcessNeverReSplitsEscrowedFunds() public {
        vm.deal(address(splitter), 1 ether);
        splitter.process();
        assertEq(splitter.buybackPending(), 0.25 ether);

        // No new funds -> reverts (nothing new to split).
        vm.expectRevert(
            abi.encodeWithSelector(
                MuseDogsFeeSplitter.BelowThreshold.selector,
                threshold,
                0
            )
        );
        splitter.process();

        // New deposit of exactly the threshold: only the new 0.1 ETH is split.
        vm.deal(address(splitter), address(splitter).balance + 0.1 ether);
        uint256 mikeyBefore = mikey.balance;
        splitter.process();

        assertEq(mikey.balance - mikeyBefore, 0.01 ether, "10% of the NEW 0.1");
        assertEq(splitter.buybackPending(), 0.25 ether + 0.025 ether, "old + 25% of new");
        assertEq(splitter.liquidityPending(), 0.25 ether + 0.025 ether);
        assertEq(
            address(splitter).balance,
            splitter.totalPending(),
            "balance always equals escrowed total"
        );
    }

    // -------------------------------------------------------------------------
    // Fail-open pushes + permissionless retry
    // -------------------------------------------------------------------------

    function test_RevertingRecipientFailsOpenIntoPending() public {
        RevertingReceiver badMikey = new RevertingReceiver();
        MuseDogsFeeSplitter s = new MuseDogsFeeSplitter(
            payable(address(badMikey)),
            vault,
            owner,
            threshold
        );
        vm.deal(address(s), 1 ether);
        s.process(); // must NOT revert even though mikey push fails
        assertEq(s.mikeyPending(), 0.1 ether, "failed push stays pending");
        assertEq(vault.balance, 0.4 ether, "vault leg unaffected");

        // Anyone can retry once the recipient is fixed — simulate by flipping
        // the receiver to accepting mode.
        badMikey.setReverting(false);
        uint256 before = address(badMikey).balance;
        vm.prank(address(0xA77));
        s.claimMikey();
        assertEq(address(badMikey).balance - before, 0.1 ether);
        assertEq(s.mikeyPending(), 0);
    }

    function test_ClaimRewardsRetry() public {
        RevertingReceiver badVault = new RevertingReceiver();
        MuseDogsFeeSplitter s = new MuseDogsFeeSplitter(
            mikey,
            payable(address(badVault)),
            owner,
            threshold
        );
        vm.deal(address(s), 1 ether);
        s.process();
        assertEq(s.rewardsPending(), 0.4 ether);
        badVault.setReverting(false);
        s.claimRewards();
        assertEq(address(badVault).balance, 0.4 ether);
    }

    function test_ClaimNothingPendingReverts() public {
        vm.expectRevert(MuseDogsFeeSplitter.NothingPending.selector);
        splitter.claimMikey();
        vm.expectRevert(MuseDogsFeeSplitter.NothingPending.selector);
        splitter.claimRewards();
    }

    // -------------------------------------------------------------------------
    // Owner forwarding of the DEX legs
    // -------------------------------------------------------------------------

    function test_ForwardBuybackAndLiquidity() public {
        vm.deal(address(splitter), 1 ether);
        splitter.process();

        address payable burnExec = payable(address(0x8EED));
        address payable lpExec = payable(address(0x1A));

        vm.prank(owner);
        splitter.forwardBuyback(burnExec, 0.25 ether);
        assertEq(burnExec.balance, 0.25 ether);
        assertEq(splitter.buybackPending(), 0);

        // Partial forwards are allowed.
        vm.prank(owner);
        splitter.forwardLiquidity(lpExec, 0.1 ether);
        assertEq(lpExec.balance, 0.1 ether);
        assertEq(splitter.liquidityPending(), 0.15 ether);
    }

    function test_ForwardOnlyOwner() public {
        vm.deal(address(splitter), 1 ether);
        splitter.process();
        vm.prank(address(0xBAD));
        vm.expectRevert();
        splitter.forwardBuyback(payable(address(0x1)), 0.1 ether);
        vm.prank(address(0xBAD));
        vm.expectRevert();
        splitter.forwardLiquidity(payable(address(0x1)), 0.1 ether);
    }

    function test_ForwardMoreThanBucketReverts() public {
        vm.deal(address(splitter), 1 ether);
        splitter.process();
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                MuseDogsFeeSplitter.InsufficientPending.selector,
                0.26 ether,
                0.25 ether
            )
        );
        splitter.forwardBuyback(payable(address(0x1)), 0.26 ether);
    }

    function test_ForwardZeroDestinationReverts() public {
        vm.deal(address(splitter), 1 ether);
        splitter.process();
        vm.prank(owner);
        vm.expectRevert(MuseDogsFeeSplitter.ZeroAddress.selector);
        splitter.forwardBuyback(payable(address(0)), 0.1 ether);
    }

    function test_ForwardFailedTransferRestoresBucket() public {
        RevertingReceiver bad = new RevertingReceiver();
        vm.deal(address(splitter), 1 ether);
        splitter.process();
        vm.prank(owner);
        vm.expectRevert(MuseDogsFeeSplitter.TransferFailed.selector);
        splitter.forwardBuyback(payable(address(bad)), 0.1 ether);
        assertEq(splitter.buybackPending(), 0.25 ether, "bucket restored");
    }

    // -------------------------------------------------------------------------
    // Threshold management + Ownable2Step
    // -------------------------------------------------------------------------

    function test_SetThreshold() public {
        vm.prank(owner);
        splitter.setProcessThreshold(1 ether);
        assertEq(splitter.processThreshold(), 1 ether);
    }

    function test_SetThresholdZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(MuseDogsFeeSplitter.ZeroThreshold.selector);
        splitter.setProcessThreshold(0);
    }

    function test_SetThresholdOnlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        splitter.setProcessThreshold(1 ether);
    }

    function test_Ownable2Step() public {
        address multisig = address(0x5AFE);
        vm.prank(owner);
        splitter.transferOwnership(multisig);
        assertEq(splitter.owner(), owner, "not moved until accepted");
        vm.prank(multisig);
        splitter.acceptOwnership();
        assertEq(splitter.owner(), multisig);
    }

    function test_ConstructorZeroChecks() public {
        vm.expectRevert(MuseDogsFeeSplitter.ZeroAddress.selector);
        new MuseDogsFeeSplitter(payable(address(0)), vault, owner, threshold);
        vm.expectRevert(MuseDogsFeeSplitter.ZeroAddress.selector);
        new MuseDogsFeeSplitter(mikey, payable(address(0)), owner, threshold);
        vm.expectRevert(MuseDogsFeeSplitter.ZeroAddress.selector);
        new MuseDogsFeeSplitter(mikey, vault, address(0), threshold);
        vm.expectRevert(MuseDogsFeeSplitter.ZeroThreshold.selector);
        new MuseDogsFeeSplitter(mikey, vault, owner, 0);
        // An EOA cannot be the rewards vault (the 40% leg is pushed to it).
        vm.expectRevert(
            abi.encodeWithSelector(
                MuseDogsFeeSplitter.NotAContract.selector,
                address(0xE0A)
            )
        );
        new MuseDogsFeeSplitter(mikey, payable(address(0xE0A)), owner, threshold);
    }

    function test_RoyaltyReceivedEvent() public {
        vm.expectEmit(true, false, false, true);
        emit MuseDogsFeeSplitter.RoyaltyReceived(address(this), 0.5 ether);
        (bool ok, ) = address(splitter).call{value: 0.5 ether}("");
        assertTrue(ok);
    }

    // -------------------------------------------------------------------------
    // Reentrancy: malicious mikey tries to re-enter process() during the push
    // -------------------------------------------------------------------------

    function test_ReentrantMikeyCannotDrain() public {
        ReentrantMikey evil = new ReentrantMikey();
        MuseDogsFeeSplitter s = new MuseDogsFeeSplitter(
            payable(address(evil)),
            vault,
            owner,
            threshold
        );
        evil.setSplitter(s);
        vm.deal(address(s), 1 ether);

        s.process(); // evil's receive() tries to re-enter process()

        assertTrue(evil.attacked(), "attacker did try to re-enter");
        // The reentrant inner process() reverted (nonReentrant), so the
        // attacker got EXACTLY its legitimate 10% share, once — no more.
        assertEq(address(evil).balance, 0.1 ether, "attacker paid exactly once");
        assertEq(s.mikeyPending(), 0, "mikey leg settled");
        assertEq(vault.balance, 0.4 ether, "vault leg unaffected");
        assertEq(s.buybackPending(), 0.25 ether, "buyback bucket intact");
        assertEq(s.liquidityPending(), 0.25 ether, "liquidity bucket intact");
        // And there is nothing left to double-dip: no new funds, so process()
        // reverts.
        vm.expectRevert(
            abi.encodeWithSelector(
                MuseDogsFeeSplitter.BelowThreshold.selector,
                threshold,
                0
            )
        );
        s.process();
    }
}

/// @notice Receiver whose fallback reverts while the flag is set.
contract RevertingReceiver {
    bool public reverting = true;

    function setReverting(bool v) external {
        reverting = v;
    }

    receive() external payable {
        require(!reverting, "nope");
    }
}

/// @notice Malicious mikey: re-enters process() from receive().
contract ReentrantMikey {
    MuseDogsFeeSplitter internal s;
    bool public attacked;

    function setSplitter(MuseDogsFeeSplitter _s) external {
        s = _s;
    }

    receive() external payable {
        attacked = true;
        // Attempt reentry: with nonReentrant this reverts, and _tryPush
        // swallows it as a failed push (funds stay in mikeyPending).
        try s.process() {} catch {}
    }
}
