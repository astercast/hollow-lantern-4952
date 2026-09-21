#!/bin/bash
# Muse Dogs — FULL testnet rehearsal on Robinhood Chain testnet (chain 46630).
# TESTNET ONLY. Aborts if the RPC is not chain 46630 or the deployer is unfunded.
# Reads keys from /tmp/musedogs-testnet/keys.json (chmod 600). Never prints secrets.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

RPC="https://rpc.testnet.chain.robinhood.com"
EXPECTED_CHAIN=46630
DIR="/tmp/musedogs-testnet"
KEYS_JSON="$DIR/keys.json"
[ -f "$KEYS_JSON" ] || KEYS_JSON="$HOME/workspace/muse-dog-lol/hidden_files/testnet-rehearsal-keys.json"
CONTRACTS="$HOME/workspace/muse-dog-lol/contracts"
API="$HOME/workspace/muse-dog-lol/api"
OUT="$DIR/rehearsal-results.md"
[ -d "$DIR" ] || { DIR="$HOME/workspace/muse-dog-lol/hidden_files"; OUT="$DIR/rehearsal-results.md"; }

k() { python3 -c "import json; d=json.load(open('$KEYS_JSON')); print(d['$1']['$2'])"; }
DEPLOYER_ADDR=$(k deployer address);       DEPLOYER_PK=$(k deployer private_key)
SIGNER_ADDR=$(k voucher_signer address);   SIGNER_PK=$(k voucher_signer private_key)
SAFE_ADDR=$(k safe address);               SAFE_PK=$(k safe private_key)
RECIPIENT_ADDR=$(k recipient address)
MIKEY_ADDR=$(k mikey address)
REWARDS_ADDR=$(k rewards address)

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$OUT"; }
txhash() { grep -oE '"transactionHash": "0x[0-9a-f]{64}"' "$1" | head -1 | cut -d'"' -f4; }

{
echo "# Muse Dogs testnet rehearsal — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "RPC: $RPC (expect chain $EXPECTED_CHAIN)"
echo "deployer: $DEPLOYER_ADDR"
echo "voucher_signer: $SIGNER_ADDR"
echo "safe (test multisig stand-in): $SAFE_ADDR"
echo "recipient: $RECIPIENT_ADDR"
echo "mikey (10% leg): $MIKEY_ADDR"
echo "rewards vault (50% leg): $REWARDS_ADDR"
echo ""
} > "$OUT"

log "STEP 0 — preflight: chain id + deployer funding"
CHAIN=$(cast chain-id --rpc-url "$RPC")
[ "$CHAIN" = "$EXPECTED_CHAIN" ] || { log "FATAL: chain is $CHAIN, expected $EXPECTED_CHAIN. Refusing to continue."; exit 1; }
log "chain-id OK: $CHAIN"
BAL=$(cast balance "$DEPLOYER_ADDR" --rpc-url "$RPC")
[ "$BAL" != "0" ] || { log "FATAL: deployer $DEPLOYER_ADDR has 0 testnet ETH. Fund via https://faucet.testnet.chain.robinhood.com/ then re-run."; exit 2; }
log "deployer balance: $BAL wei — funded, proceeding"

log "STEP 1 — deploy splitter, then NFT (Deploy.s.sol wires royalties at construction)"
cd "$CONTRACTS"
export MIKEY_BANKR="$MIKEY_ADDR" REWARDS_VAULT="$REWARDS_ADDR"
export MUSEDOG_OWNER="$DEPLOYER_ADDR" MUSEDOG_VOUCHER_SIGNER="$SIGNER_ADDR"
export PROCESS_THRESHOLD_WEI=1000000000000000   # 0.001 ETH — small so the test royalty triggers process()
ZERO=0x0000000000000000000000000000000000000000
for p in META_ETH META_MDOG META_MUSEBOOK MDOG_ETH; do
  export ${p}_FEE=3000 ${p}_TICK_SPACING=60 ${p}_HOOKS=$ZERO
done
# MDOG_MUSEBOOK has verified defaults in the script; no pools exist on testnet
# so every DEX leg is expected to take the skip-and-hatch path.
forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast \
  --private-key "$DEPLOYER_PK" > "$DIR/deploy.out" 2>&1
SPLITTER=$(grep -oE 'MuseDogsFeeSplitter: 0x[0-9a-fA-F]{40}' "$DIR/deploy.out" | head -1 | awk '{print $2}')
NFT=$(grep -oE 'MuseDogs: 0x[0-9a-fA-F]{40}' "$DIR/deploy.out" | head -1 | awk '{print $2}')
[ -n "$SPLITTER" ] && [ -n "$NFT" ] || { log "FATAL: could not parse deployed addresses"; tail -20 "$DIR/deploy.out" | tee -a "$OUT"; exit 1; }
log "PASS deploy — splitter: $SPLITTER"
log "PASS deploy — nft: $NFT"
echo "splitter: $SPLITTER" >> "$OUT"; echo "nft: $NFT" >> "$OUT"
BROADCAST_JSON=$(ls -t "$CONTRACTS/broadcast/Deploy.s.sol/$EXPECTED_CHAIN"/run-*.json | head -1)
log "broadcast artifact: $BROADCAST_JSON"

log "verify royalty wiring: royaltyInfo(1 ether)"
cast call "$NFT" "royaltyInfo(uint256,uint256)" 1 1000000000000000000 --rpc-url "$RPC" | tee -a "$OUT"
# expect receiver == $SPLITTER, amount == 0.07 ether = 70000000000000000

log "STEP 2 — setBaseURI with TEST value (never the real Arweave manifest)"
TEST_URI="https://test.musedog.lol/meta/"
cast send "$NFT" "setBaseURI(string)" "$TEST_URI" --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-baseuri.json" 2>&1
log "setBaseURI tx: $(txhash $DIR/tx-baseuri.json)"
URI1=$(cast call "$NFT" "tokenURI(uint256)" 1 --rpc-url "$RPC")
log "tokenURI(1) = $URI1 (expect ${TEST_URI}1.json)"
[ "$URI1" = "${TEST_URI}1.json" ] && log "PASS setBaseURI" || log "FAIL setBaseURI"

log "STEP 3 — teamMint 20"
TEAM_JSON=$(for i in $(seq 1 20); do cast wallet new --json; done | python3 -c "
import json,sys
addrs=[json.loads(l)['data'][0]['address'] for l in sys.stdin if l.strip()]
print('[' + ','.join(addrs) + ']')")
cast send "$NFT" "teamMint(address[])" "$TEAM_JSON" --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-teammint.json" 2>&1
log "teamMint tx: $(txhash $DIR/tx-teammint.json)"
MINTED=$(cast call "$NFT" "totalMinted()" --rpc-url "$RPC")
log "totalMinted = $MINTED (expect 20)"
OWNER1=$(cast call "$NFT" "ownerOf(uint256)" 1 --rpc-url "$RPC")
log "ownerOf(1) = $OWNER1"
[ "$MINTED" = "20" ] && log "PASS teamMint" || log "FAIL teamMint"

log "STEP 4 — ownership handoff to test safe (2-step, mimics Safe)"
cast send "$NFT" "transferOwnership(address)" "$SAFE_ADDR" --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-t1.json" 2>&1
cast send "$SPLITTER" "transferOwnership(address)" "$SAFE_ADDR" --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-t2.json" 2>&1
log "transferOwnership txs: $(txhash $DIR/tx-t1.json), $(txhash $DIR/tx-t2.json)"
PENDING_OWNER=$(cast call "$NFT" "owner()" --rpc-url "$RPC")
log "owner() before accept = $PENDING_OWNER (expect still deployer $DEPLOYER_ADDR — 2-step)"
cast send "$NFT" "acceptOwnership()" --private-key "$SAFE_PK" --rpc-url "$RPC" > "$DIR/tx-a1.json" 2>&1
cast send "$SPLITTER" "acceptOwnership()" --private-key "$SAFE_PK" --rpc-url "$RPC" > "$DIR/tx-a2.json" 2>&1
log "acceptOwnership txs: $(txhash $DIR/tx-a1.json), $(txhash $DIR/tx-a2.json)"
NFT_OWNER=$(cast call "$NFT" "owner()" --rpc-url "$RPC")
SPLIT_OWNER=$(cast call "$SPLITTER" "owner()" --rpc-url "$RPC")
log "nft owner() = $NFT_OWNER | splitter owner() = $SPLIT_OWNER (expect both $SAFE_ADDR)"
[ "$NFT_OWNER" = "$SAFE_ADDR" ] && [ "$SPLIT_OWNER" = "$SAFE_ADDR" ] && log "PASS ownership handoff" || log "FAIL ownership handoff"
# from here on, owner-only calls must come from the SAFE key
OWNER_PK="$SAFE_PK"

log "STEP 5 — real voucher from backend signing code (fresh test key), relayed on-chain"
EXPIRY=$(( $(date +%s) + 3600 ))
SIGNATURE=$(cd "$API" && node -e "
const {signVoucher} = require('./lib/voucher.js');
const keys = require('$KEYS_JSON');
signVoucher(keys.voucher_signer.private_key, {
  chainId: $EXPECTED_CHAIN,
  contractAddress: '$NFT',
  recipient: '$RECIPIENT_ADDR',
  mintType: 0,
  nonce: 7,
  expiry: $EXPIRY,
}).then(s => console.log(s.trim()));")
log "voucher signed (sig prefix ${SIGNATURE:0:12}..., expiry $EXPIRY)"
cast send "$NFT" "mintWithVoucher(address,uint8,uint256,uint256,bytes)" \
  "$RECIPIENT_ADDR" 0 7 "$EXPIRY" "$SIGNATURE" \
  --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-voucher.json" 2>&1
log "mintWithVoucher tx: $(txhash $DIR/tx-voucher.json)"
OWNER21=$(cast call "$NFT" "ownerOf(uint256)" 21 --rpc-url "$RPC")
log "ownerOf(21) = $OWNER21 (expect $RECIPIENT_ADDR)"
[ "$OWNER21" = "$RECIPIENT_ADDR" ] && log "PASS voucher mint" || log "FAIL voucher mint"
# negative control: replay same voucher must revert (nonce used)
if cast send "$NFT" "mintWithVoucher(address,uint8,uint256,uint256,bytes)" \
  "$RECIPIENT_ADDR" 0 7 "$EXPIRY" "$SIGNATURE" \
  --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-replay.json" 2>&1; then
  log "FAIL replay protection — reused nonce minted!"
else
  log "PASS replay protection — reused nonce reverted: $(grep -oE 'NonceAlreadyUsed|revert' "$DIR/tx-replay.json" | head -1)"
fi

log "STEP 6 — simulated royalty (0.01 ETH) + process(): split math + skip-and-hatch"
MIKEY_BEFORE=$(cast balance "$MIKEY_ADDR" --rpc-url "$RPC")
REWARDS_BEFORE=$(cast balance "$REWARDS_ADDR" --rpc-url "$RPC")
cast send "$SPLITTER" --value 10000000000000000 --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-royalty.json" 2>&1
log "royalty tx: $(txhash $DIR/tx-royalty.json)"
cast send "$SPLITTER" "process()" --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-process.json" 2>&1
PROCESS_TX=$(txhash "$DIR/tx-process.json")
log "process() tx: $PROCESS_TX"
MIKEY_AFTER=$(cast balance "$MIKEY_ADDR" --rpc-url "$RPC")
REWARDS_AFTER=$(cast balance "$REWARDS_ADDR" --rpc-url "$RPC")
MIKEY_DELTA=$((16#$MIKEY_AFTER - 16#$MIKEY_BEFORE))
REWARDS_DELTA=$((16#$REWARDS_AFTER - 16#$REWARDS_BEFORE))
log "mikey delta: $MIKEY_DELTA wei (expect 1000000000000000 = 10%)"
log "rewards delta: $REWARDS_DELTA wei (expect 5000000000000000 = 50%)"
SPLIT_BAL=$(cast balance "$SPLITTER" --rpc-url "$RPC")
log "splitter balance after: $SPLIT_BAL wei (expect 4000000000000000 = 40% escrowed)"
MB_PEND=$(cast call "$SPLITTER" "musebookLiquidityPending()" --rpc-url "$RPC")
LIQ_PEND=$(cast call "$SPLITTER" "liquidityPending()" --rpc-url "$RPC")
MIKEY_PEND=$(cast call "$SPLITTER" "mikeyPending()" --rpc-url "$RPC")
REW_PEND=$(cast call "$SPLITTER" "rewardsPending()" --rpc-url "$RPC")
log "musebookLiquidityPending=$MB_PEND (expect 2000000000000000) liquidityPending=$LIQ_PEND (expect 2000000000000000)"
log "mikeyPending=$MIKEY_PEND rewardsPending=$REW_PEND (expect 0, 0)"
SKIPS=$(cast receipt "$PROCESS_TX" --rpc-url "$RPC" --json 2>/dev/null | grep -c "DexLegSkipped" || true)
log "DexLegSkipped occurrences in process() receipt: $SKIPS (expect 2: musebook-liquidity + liquidity)"
[ "$MIKEY_DELTA" = "1000000000000000" ] && [ "$REWARDS_DELTA" = "5000000000000000" ] \
  && [ "$SPLIT_BAL" = "4000000000000000" ] && [ "$SKIPS" = "2" ] \
  && log "PASS royalty split + skip-and-hatch" || log "FAIL royalty split or skip path — inspect values above"

log "DONE. Full results in $OUT"
