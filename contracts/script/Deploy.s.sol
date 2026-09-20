// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {MuseDogs} from "../src/MuseDogs.sol";
import {MuseDogsFeeSplitter} from "../src/MuseDogsFeeSplitter.sol";

/// @notice Deploy Muse Dogs (NFT) + MuseDogsFeeSplitter to Robinhood Chain.
/// @dev All parameters come from environment variables. The broadcast private
///      key is passed via forge's --private-key flag (or --ledger) and NEVER
///      lives in this repo or in env files.
///
///      Required env:
///        MIKEY_BANKR          - Mikey's Bankr address (10% royalty leg, raw ETH)
///        REWARDS_VAULT        - holder rewards vault (40% leg). Deploy
///                               MuseDogRewards first, or pass the planned address.
///        MUSEDOG_OWNER        - initial owner (deployer hot wallet for the
///                               pre-launch test mint; transfer to the Safe
///                               multisig via transferOwnership/acceptOwnership
///                               immediately after).
///        MUSEDOG_VOUCHER_SIGNER - dedicated voucher-signing key address.
///        PROCESS_THRESHOLD_WEI  - min new wei per splitter process() call.
///
///      Example:
///        MIKEY_BANKR=0x... REWARDS_VAULT=0x... MUSEDOG_OWNER=0x... \
///        MUSEDOG_VOUCHER_SIGNER=0x... PROCESS_THRESHOLD_WEI=50000000000000000 \
///        forge script script/Deploy.s.sol --rpc-url robinhood \
///          --broadcast --verify -vvvv
contract Deploy is Script {
    function run() external {
        address payable mikeyBankr = payable(vm.envAddress("MIKEY_BANKR"));
        address payable rewardsVault = payable(vm.envAddress("REWARDS_VAULT"));
        address owner = vm.envAddress("MUSEDOG_OWNER");
        address voucherSigner = vm.envAddress("MUSEDOG_VOUCHER_SIGNER");
        uint256 threshold = vm.envUint("PROCESS_THRESHOLD_WEI");

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
            threshold
        );

        // 2. The collection, with the splitter wired as the 5% royalty recipient.
        MuseDogs nft = new MuseDogs(owner, voucherSigner, address(splitter));

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
    }
}
