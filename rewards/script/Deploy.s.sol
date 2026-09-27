// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/RewardsDistributor.sol";

/// @notice Deploys RewardsDistributor on Robinhood Chain.
/// @dev NOT run without Andrew's explicit deploy authorization.
/// Owner is the treasury wallet 0xEac12759e1Bb4A3c1455Ea3FE03b668c493BFb25
/// (the EOA holding the treasury MUSEBOOK) — only it can publish roots /
/// withdraw. Note: this is NOT the 1-of-2 Safe 0x0fC95658…; the Safe holds
/// no MUSEBOOK. Keep the comment honest if the owner ever changes.
///
///   forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --verify
///   (verification: Blockscout; see README)
contract DeployRewards is Script {
    address constant MUSEBOOK = 0x91A2DAe9699f0B82540B5886b0d8759C22820bA3;
    address constant TREASURY = 0xEac12759e1Bb4A3c1455Ea3FE03b668c493BFb25;

    function run() external returns (RewardsDistributor) {
        vm.startBroadcast();
        RewardsDistributor dist = new RewardsDistributor(MUSEBOOK, TREASURY);
        vm.stopBroadcast();
        console2.log("RewardsDistributor deployed at:", address(dist));
        console2.log("owner (treasury EOA):", dist.owner());
        return dist;
    }
}
