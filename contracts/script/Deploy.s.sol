// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {MuseDogs} from "../src/MuseDogs.sol";
import {MuseDogsFeeSplitter, PoolKey} from "../src/MuseDogsFeeSplitter.sol";

/// @notice Deploy Muse Dogs (NFT) + MuseDogsFeeSplitter to Robinhood Chain.
/// @dev All parameters come from environment variables. The broadcast private
///      key is passed via forge's --private-key flag (or --ledger) and NEVER
///      lives in this repo or in env files.
///
///      Required env:
///        MIKEY_BANKR          - Mikey's Bankr address (10% royalty leg, raw ETH)
///        REWARDS_VAULT        - holder rewards vault (50% leg). Deploy
///                               MuseDogRewards first, or pass the planned address.
///        MUSEDOG_OWNER        - initial owner (deployer hot wallet for the
///                               pre-launch test mint; transfer to the Safe
///                               multisig via transferOwnership/acceptOwnership
///                               immediately after).
///        MUSEDOG_VOUCHER_SIGNER - dedicated voucher-signing key address.
///        PROCESS_THRESHOLD_WEI  - min new wei per splitter process() call.
///
///      Required env (Uniswap v4 pool keys — pass the VERIFIED values; the
///      splitter pins each key's currencies itself, but fee/tickSpacing/hooks
///      must match the real pools or every DEX leg will revert and stay
///      escrowed):
///        META_ETH_FEE / META_ETH_TICK_SPACING / META_ETH_HOOKS
///        META_MDOG_FEE / META_MDOG_TICK_SPACING / META_MDOG_HOOKS
///        MDOG_ETH_FEE / MDOG_ETH_TICK_SPACING / MDOG_ETH_HOOKS
///      The pool IDs themselves are NOT passed: the splitter derives each
///      pool id as keccak256(abi.encode(poolKey)) internally.
///
///      Optional env (verified Robinhood Chain deployments are the defaults;
///      override only if Uniswap migrates its deployment):
///        POOL_MANAGER         - Uniswap v4 PoolManager
///        POSITION_MANAGER     - Uniswap v4 PositionManager
///        META_TOKEN           - META token address
///        MDOG_TOKEN           - MDOG token address
///
///      Example:
///        MIKEY_BANKR=0x... REWARDS_VAULT=0x... MUSEDOG_OWNER=0x... \
///        MUSEDOG_VOUCHER_SIGNER=0x... PROCESS_THRESHOLD_WEI=50000000000000000 \
///        META_ETH_FEE=3000 META_ETH_TICK_SPACING=60 META_ETH_HOOKS=0x0000000000000000000000000000000000000000 \
///        META_MDOG_FEE=3000 META_MDOG_TICK_SPACING=60 META_MDOG_HOOKS=0x0000000000000000000000000000000000000000 \
///        MDOG_ETH_FEE=3000 MDOG_ETH_TICK_SPACING=60 MDOG_ETH_HOOKS=0x0000000000000000000000000000000000000000 \
///        forge script script/Deploy.s.sol --rpc-url robinhood \
///          --broadcast --verify -vvvv
contract Deploy is Script {
    function run() external {
        address payable mikeyBankr = payable(vm.envAddress("MIKEY_BANKR"));
        address payable rewardsVault = payable(vm.envAddress("REWARDS_VAULT"));
        address owner = vm.envAddress("MUSEDOG_OWNER");
        address voucherSigner = vm.envAddress("MUSEDOG_VOUCHER_SIGNER");
        uint256 threshold = vm.envUint("PROCESS_THRESHOLD_WEI");

        // Verified Uniswap v4 deployments on Robinhood Chain (4663). These
        // mirror the ROBINHOOD_* constants pinned in MuseDogsFeeSplitter (see
        // its NatSpec for the verification trail); duplicated here as literals
        // because the deploy script needs them before the splitter exists.
        // Override via env only if Uniswap migrates its deployment.
        address poolManager = vm.envOr("POOL_MANAGER", 0x8366a39CC670B4001A1121B8F6A443A643e40951);
        address positionManager = vm.envOr("POSITION_MANAGER", 0x58daec3116aae6D93017bAAea7749052E8a04fA7);
        address metaToken = vm.envOr("META_TOKEN", 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35);
        address mdogToken = vm.envOr("MDOG_TOKEN", 0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC);
        address musebookToken = vm.envOr("MUSEBOOK_TOKEN", 0x91A2DAe9699f0B82540B5886b0d8759C22820bA3);

        // Pool keys: currencies are pinned by the splitter constructor
        // (native/META, MDOG/META, musebook/META, native/MDOG, MDOG/musebook);
        // fee, tickSpacing and hooks come from env and MUST be the verified
        // values for the real pools.
        PoolKey memory metaEthKey = PoolKey({
            currency0: address(0),
            currency1: metaToken,
            fee: uint24(vm.envUint("META_ETH_FEE")),
            tickSpacing: int24(vm.envInt("META_ETH_TICK_SPACING")),
            hooks: vm.envAddress("META_ETH_HOOKS")
        });
        PoolKey memory metaMdogKey = PoolKey({
            currency0: mdogToken,
            currency1: metaToken,
            fee: uint24(vm.envUint("META_MDOG_FEE")),
            tickSpacing: int24(vm.envInt("META_MDOG_TICK_SPACING")),
            hooks: vm.envAddress("META_MDOG_HOOKS")
        });
        PoolKey memory metaMusebookKey = PoolKey({
            currency0: musebookToken,
            currency1: metaToken,
            fee: uint24(vm.envUint("META_MUSEBOOK_FEE")),
            tickSpacing: int24(vm.envInt("META_MUSEBOOK_TICK_SPACING")),
            hooks: vm.envAddress("META_MUSEBOOK_HOOKS")
        });
        PoolKey memory mdogEthKey = PoolKey({
            currency0: address(0),
            currency1: mdogToken,
            fee: uint24(vm.envUint("MDOG_ETH_FEE")),
            tickSpacing: int24(vm.envInt("MDOG_ETH_TICK_SPACING")),
            hooks: vm.envAddress("MDOG_ETH_HOOKS")
        });
        // MDOG/musebook LP key: the existing pool is fee 3000, tickSpacing 60,
        // no hooks, minted full-range (-887220/887220) to the dead address.
        // Env-overridable like the rest, but these defaults are verified.
        PoolKey memory mdogMusebookKey = PoolKey({
            currency0: mdogToken,
            currency1: musebookToken,
            fee: uint24(vm.envOr("MDOG_MUSEBOOK_FEE", uint256(3000))),
            tickSpacing: int24(vm.envOr("MDOG_MUSEBOOK_TICK_SPACING", int256(60))),
            hooks: vm.envOr("MDOG_MUSEBOOK_HOOKS", address(0))
        });

        require(mikeyBankr != address(0), "MIKEY_BANKR is zero");
        require(rewardsVault != address(0), "REWARDS_VAULT is zero");
        require(owner != address(0), "MUSEDOG_OWNER is zero");
        require(voucherSigner != address(0), "MUSEDOG_VOUCHER_SIGNER is zero");
        require(threshold > 0, "PROCESS_THRESHOLD_WEI is zero");

        vm.startBroadcast();

        // 1. Fee splitter first (its address goes into the NFT's royalty config).
        MuseDogsFeeSplitter splitter = new MuseDogsFeeSplitter(
            mikeyBankr,
            rewardsVault,
            owner,
            threshold,
            poolManager,
            positionManager,
            metaToken,
            mdogToken,
            musebookToken,
            metaEthKey,
            metaMdogKey,
            metaMusebookKey,
            mdogEthKey,
            mdogMusebookKey
        );

        // 2. The collection, with the splitter wired as the 7% royalty recipient.
        MuseDogs nft = new MuseDogs(owner, voucherSigner, address(splitter), mdogToken);

        vm.stopBroadcast();

        console.log("MuseDogsFeeSplitter:", address(splitter));
        console.log("MuseDogs:", address(nft));
        console.log("owner:", nft.owner());
        console.log("voucherSigner:", nft.voucherSigner());
        console.log("feeSplitter:", nft.feeSplitter());
        (address receiver, uint256 amount) = nft.royaltyInfo(1, 1 ether);
        console.log("royaltyInfo(1 ether) receiver:", receiver);
        console.log("royaltyInfo(1 ether) amount:", amount);

        // Post-deploy checklist (human steps, NOT automated):
        //   1. Verify source on Blockscout for both contracts.
        //   2. Upload art+metadata to Arweave, then call setBaseURI ONCE.
        //   3. teamMint the 20 team/treasury NFTs from the deployer wallet.
        //   4. Verify metadata/royalties on the explorer.
        //   5. transferOwnership(multisig) on BOTH contracts; multisig calls
        //      acceptOwnership() on each. Confirm owner() == multisig.
        //   6. Dry-run splitter.process() with a keeper call and confirm the
        //      buyback + liquidity legs execute against the real pools.
        //   7. ON MINT DAY: the multisig calls setHolderThresholdMDOG with
        //      the raw MDOG amount worth ~$10 at the live price. Until this
        //      is set, the holder path is closed (fail-closed:
        //      mintWithVoucher reverts HOLDER mints with HolderThresholdNotSet).
    }
}
