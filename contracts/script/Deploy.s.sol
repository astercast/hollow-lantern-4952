// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {MuseDog} from "../src/MuseDog.sol";

/// @notice Deploy MuseDog to Robinhood Chain (or testnet).
/// @dev Fill in the constructor args via environment variables, then run:
///      forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --verify
///      Blockscout verification is configured in foundry.toml via [etherscan].
contract Deploy is Script {
    function run() external returns (MuseDog) {
        address initialOwner = vm.envAddress("MUSEDOG_OWNER"); // 2-of-3 multisig
        address voucherSigner = vm.envAddress("MUSEDOG_VOUCHER_SIGNER"); // KMS address
        string memory baseURI = vm.envOr("MUSEDOG_BASE_URI", string(""));
        address royaltyReceiver = vm.envOr("MUSEDOG_ROYALTY_RECEIVER", address(0));
        uint96 royaltyBps = uint96(vm.envOr("MUSEDOG_ROYALTY_BPS", uint256(0)));

        vm.startBroadcast();
        MuseDog muse = new MuseDog(
            initialOwner,
            voucherSigner,
            baseURI,
            royaltyReceiver,
            royaltyBps
        );
        vm.stopBroadcast();
        return muse;
    }
}
