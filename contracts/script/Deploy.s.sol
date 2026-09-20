// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {MuseDog} from "../src/MuseDog.sol";
import {MuseDogFeeEngine} from "../src/MuseDogFeeEngine.sol";
import {MuseDogRoyaltySplitter} from "../src/MuseDogRoyaltySplitter.sol";
import {MuseDogRewards} from "../src/MuseDogRewards.sol";

/// @title Deploy — full Muse Dogs deployment in dependency order
/// @notice Deploys to Robinhood Chain (chain id 4663) or its testnet (46630).
///         Run: forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --verify
///         Blockscout verification is configured in foundry.toml via [etherscan].
/// @dev Deployment order (dependencies first):
///      1. MuseDogRewards      <- REWARDS_PUBLISHER
///      2. MuseDogFeeEngine     <- FEEENGINE_* (8 ctor args; PoolKey assembled from env)
///      3. MuseDogRoyaltySplitter <- SPLITTER_MIKEY (default: Mikey's Bankr address), rewards, fee engine
///      4. MuseDog              <- MUSEDOG_OWNER, MUSEDOG_VOUCHER_SIGNER, MUSEDOG_BASE_URI, splitter, royalty bps
///
///      Every constructor parameter comes from an environment variable:
///
///      REWARDS
///        REWARDS_PUBLISHER (address, REQUIRED) — project multisig authorized to publish weekly
///            merkle roots to MuseDogRewards. No default: must be set.
///
///      FEE ENGINE
///        FEEENGINE_MDOG (address, REQUIRED) — MDOG token on Robinhood Chain.
///        FEEENGINE_WETH (address, REQUIRED) — WETH on Robinhood Chain.
///        FEEENGINE_UNIVERSAL_ROUTER (address, REQUIRED) — Uniswap V4 Universal Router.
///        FEEENGINE_POSITION_MANAGER (address, REQUIRED) — Uniswap V4 Position Manager.
///        FEEENGINE_POOL_CURRENCY0 (address, REQUIRED) — pool key currency0 (ETH leg or WETH).
///        FEEENGINE_POOL_CURRENCY1 (address, REQUIRED) — pool key currency1 (the other side; one must be MDOG).
///        FEEENGINE_POOL_FEE (uint24, default 3000) — pool fee in hundredths of a bps (3000 = 0.3%).
///        FEEENGINE_POOL_TICKSPACING (int24, default 60) — pool tick spacing.
///        FEEENGINE_POOL_HOOKS (address, REQUIRED) — pool hooks address (zero address for no hooks).
///        FEEENGINE_MIN_PROCESS_AMOUNT (uint256, default 0.001 ether) — dust guard: process() reverts
///            below this vault balance.
///        FEEENGINE_BURN_BPS (uint256, default 5000) — share of each run going to buyback-and-burn
///            MDOG (5000 = 50% of the 6.5% remaining after Mikey's cut; rest becomes LP).
///        FEEENGINE_MIKEY (address, default 0x3a66aec855e605966aebba7df75eb858019b8516) — Mikey's
///            Bankr address; receives 0.5% of the royalty in raw ETH off the top of every process() run.
///      NOTE: the pinned 6-arg FeeEngine interface grew during Worker B's build — the live
///            constructor also takes burnBps and mikey (immutable burn split + Mikey's cut).
///
///      SPLITTER
///        SPLITTER_MIKEY (address, default 0x3a66aec855e605966aebba7df75eb858019b8516) — Mikey's
///            Bankr address; receives the 0.5% slice of the 5% royalty.
///
///      MUSE DOG (collection)
///        MUSEDOG_OWNER (address, REQUIRED) — 2-of-3 project multisig (initial owner).
///        MUSEDOG_VOUCHER_SIGNER (address, REQUIRED) — dedicated KMS voucher signer.
///        MUSEDOG_BASE_URI (string, default "") — initial base token URI.
///      The collection locks EIP-2981 royalties at 5% (500 bps) paid to the
///      splitter; no royalty-bps env var exists.
contract Deploy is Script {
    /// @notice Mikey's Bankr address (default for SPLITTER_MIKEY and FEEENGINE_MIKEY).
    address internal constant MIKEY_DEFAULT = 0x3A66aEc855E605966AebbA7df75eB858019B8516;

    /// @notice Deploys all four contracts in dependency order and returns them.
    /// @return rewards The MuseDogRewards holder-rewards vault.
    /// @return feeEngine The MuseDogFeeEngine autonomous royalty loop.
    /// @return splitter The MuseDogRoyaltySplitter (receives MuseDog ERC-2981 royalties).
    /// @return muse The MuseDog ERC-721 collection.
    function run()
        external
        returns (
            MuseDogRewards rewards,
            MuseDogFeeEngine feeEngine,
            MuseDogRoyaltySplitter splitter,
            MuseDog muse
        )
    {
        vm.startBroadcast();
        rewards = _deployRewards();
        feeEngine = _deployFeeEngine();
        splitter = _deploySplitter(address(rewards), address(feeEngine));
        muse = _deployMuse(address(splitter));
        vm.stopBroadcast();
    }

    function _deployRewards() internal returns (MuseDogRewards) {
        return new MuseDogRewards(vm.envAddress("REWARDS_PUBLISHER"));
    }

    function _deployFeeEngine() internal returns (MuseDogFeeEngine) {
        MuseDogFeeEngine.PoolKey memory poolKey = MuseDogFeeEngine.PoolKey({
            currency0: vm.envAddress("FEEENGINE_POOL_CURRENCY0"),
            currency1: vm.envAddress("FEEENGINE_POOL_CURRENCY1"),
            fee: uint24(vm.envOr("FEEENGINE_POOL_FEE", uint256(3000))),
            tickSpacing: int24(vm.envOr("FEEENGINE_POOL_TICKSPACING", int256(60))),
            hooks: vm.envAddress("FEEENGINE_POOL_HOOKS")
        });
        return new MuseDogFeeEngine(
            vm.envAddress("FEEENGINE_MDOG"),
            vm.envAddress("FEEENGINE_WETH"),
            vm.envAddress("FEEENGINE_UNIVERSAL_ROUTER"),
            vm.envAddress("FEEENGINE_POSITION_MANAGER"),
            poolKey,
            vm.envOr("FEEENGINE_MIN_PROCESS_AMOUNT", uint256(0.001 ether))
            // NOTE (Worker B, fee-engine rebase): burnBps/mikey args removed —
            // the pinned 6-arg constructor fixes the 50/50 split in code and
            // Mikey's cut now lives in MuseDogRoyaltySplitter.
        );
    }

    function _deploySplitter(address rewardsVault, address feeEngine) internal returns (MuseDogRoyaltySplitter) {
        return new MuseDogRoyaltySplitter(vm.envOr("SPLITTER_MIKEY", MIKEY_DEFAULT), rewardsVault, feeEngine);
    }

    function _deployMuse(address splitter) internal returns (MuseDog) {
        return new MuseDog(
            vm.envAddress("MUSEDOG_OWNER"),
            vm.envAddress("MUSEDOG_VOUCHER_SIGNER"),
            vm.envOr("MUSEDOG_BASE_URI", string("")),
            splitter
        );
    }
}
