#!/bin/bash
# Muse Dogs — NFT-ONLY testnet rehearsal (chain 46630), v2.
# The FeeSplitter cannot deploy off mainnet by design (constructor reverts
# WrongChainId anywhere but 4663) — documented, not a bug. This leg rehearses
# everything the NFT contract itself can do on testnet.
# TESTNET ONLY. Aborts if the RPC is not chain 46630.
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
TEST_URI="https://arweave.net/TEST-REHEARSAL-NOT-REAL/"

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$OUT"; }
# cast send prints human-readable "transactionHash      0x..." (not JSON)
txhash() { grep -oE '^transactionHash[[:space:]]+0x[0-9a-f]{64}' "$1" | head -1 | awk '{print $2}'; }
# normalize an address for comparison: strip 0x, lowercase, last 40 hex chars
norm() { local h="${1#0x}"; h="${h,,}"; echo "${h: -40}"; }
# decode an ABI-encoded string return value to plain text
abistr() { python3 -c "
import sys
d = bytes.fromhex(sys.argv[1][2:] if sys.argv[1].startswith('0x') else sys.argv[1])
print(d[64:].decode('utf-8', 'replace').strip(chr(0))" "$1"; }

pass=0; fail=0
check() { # check <name> <actual> <expected>
  if [ "$(norm "$2")" = "$(norm "$3")" ]; then log "PASS $1"; pass=$((pass+1));
  else log "FAIL $1 — got $2, want $3"; fail=$((fail+1)); fi
}

{
echo ""
echo "## NFT-only leg v2 — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "NOTE: FeeSplitter refuses testnet by design (WrongChainId guard). NFT-only rehearsal."
log "STEP 0 — preflight"
CHAIN=$(cast chain-id --rpc-url "$RPC")
[ "$CHAIN" = "$EXPECTED_CHAIN" ] || { log "FATAL: chain $CHAIN != $EXPECTED_CHAIN"; exit 1; }
BAL=$(cast balance "$DEPLOYER_ADDR" --rpc-url "$RPC")
[ "$BAL" != "0" ] || { log "FATAL: deployer unfunded"; exit 2; }
log "chain-id OK: $CHAIN | deployer balance: $BAL wei"

log "STEP 1 — deploy MockToken (mdog stand-in) then MuseDogs"
cd "$CONTRACTS"
MOCK=$(forge create test/MuseDogsFeeSplitter.t.sol:MockToken --rpc-url "$RPC" \
  --private-key "$DEPLOYER_PK" --broadcast 2>&1 | grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' | awk '{print $3}')
[ -n "$MOCK" ] || { log "FATAL: mock deploy failed"; exit 1; }
log "PASS mock MDOG: $MOCK"
NFT=$(forge create src/MuseDogs.sol:MuseDogs --rpc-url "$RPC" \
  --private-key "$DEPLOYER_PK" --broadcast \
  --constructor-args "$DEPLOYER_ADDR" "$SIGNER_ADDR" "$MOCK" "$MOCK" 2>&1 | tee "$DIR/deploy-nft.out" | grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' | awk '{print $3}')
[ -n "$NFT" ] || { log "FATAL: NFT deploy failed"; tail -5 "$DIR/deploy-nft.out" | tee -a "$OUT"; exit 1; }
log "PASS deploy — nft: $NFT"
echo "nft (testnet): $NFT" >> "$OUT"; echo "mock mdog (testnet): $MOCK" >> "$OUT"

log "verify constructor wiring"
check "owner"        "$(cast call "$NFT" "owner()" --rpc-url "$RPC")"                        "$DEPLOYER_ADDR"
check "voucherSigner" "$(cast call "$NFT" "voucherSigner()" --rpc-url "$RPC")"               "$SIGNER_ADDR"
check "feeSplitter"  "$(cast call "$NFT" "feeSplitter()" --rpc-url "$RPC")"                  "$MOCK"
RINFO=$(cast call "$NFT" "royaltyInfo(uint256,uint256)" 1 1000000000000000000 --rpc-url "$RPC")
RAMOUNT_HEX=$(echo "$RINFO" | tail -c 65)
RAMOUNT=$((16#${RAMOUNT_HEX#0x}))
RRECV="0x${RINFO:26:40}"
if [ "$(norm "$RRECV")" = "$(norm "$MOCK")" ] && [ "$RAMOUNT" = "70000000000000000" ]; then
  log "PASS royaltyInfo — receiver=mock, amount=0.07 ether"; pass=$((pass+1))
else log "FAIL royaltyInfo — $RINFO"; fail=$((fail+1)); fi

log "fund the test-safe address so it can submit acceptOwnership"
cast send "$SAFE_ADDR" --value 2000000000000000 --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > /dev/null 2>&1
log "safe funded: $(cast balance "$SAFE_ADDR" --rpc-url "$RPC") wei"

log "STEP 2 — setBaseURI with TEST value"
cast send "$NFT" "setBaseURI(string)" "$TEST_URI" --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-baseuri.json" 2>&1
log "setBaseURI tx: $(txhash $DIR/tx-baseuri.json)"

log "STEP 3 — teamMint 20"
TEAM_JSON=$(for i in $(seq 1 20); do cast wallet new --json; done | python3 -c "
import json,sys
addrs=[json.loads(l)['data'][0]['address'] for l in sys.stdin if l.strip()]
print('[' + ','.join(addrs) + ']')")
cast send "$NFT" "teamMint(address[])" "$TEAM_JSON" --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-teammint.json" 2>&1
log "teamMint tx: $(txhash $DIR/tx-teammint.json)"
MINTED_HEX=$(cast call "$NFT" "totalMinted()" --rpc-url "$RPC")
MINTED=$((16#${MINTED_HEX#0x}))
URI1=$(abistr "$(cast call "$NFT" "tokenURI(uint256)" 1 --rpc-url "$RPC")")
if [ "$MINTED" = "20" ] && [ "$URI1" = "${TEST_URI}1.json" ]; then
  log "PASS teamMint+metadata — totalMinted=20, tokenURI(1)=$URI1"; pass=$((pass+1))
else log "FAIL teamMint+metadata — totalMinted=$MINTED tokenURI(1)=$URI1"; fail=$((fail+1)); fi
check "ownerOf(1) is a team address" "$(cast call "$NFT" "ownerOf(uint256)" 1 --rpc-url "$RPC")" "$(echo "$TEAM_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)[0])")"

log "STEP 4 — ownership handoff (Ownable2Step)"
cast send "$NFT" "transferOwnership(address)" "$SAFE_ADDR" --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-t1.json" 2>&1
log "transferOwnership tx: $(txhash $DIR/tx-t1.json)"
check "owner unchanged before accept (2-step)" "$(cast call "$NFT" "owner()" --rpc-url "$RPC")" "$DEPLOYER_ADDR"
cast send "$NFT" "acceptOwnership()" --private-key "$SAFE_PK" --rpc-url "$RPC" > "$DIR/tx-a1.json" 2>&1
log "acceptOwnership tx: $(txhash $DIR/tx-a1.json)"
check "owner after accept" "$(cast call "$NFT" "owner()" --rpc-url "$RPC")" "$SAFE_ADDR"

log "STEP 5 — real voucher from backend signing code, relayed on-chain"
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
log "voucher signed (sig ${SIGNATURE:0:12}..., expiry $EXPIRY)"
cast send "$NFT" "mintWithVoucher(address,uint8,uint256,uint256,bytes)" \
  "$RECIPIENT_ADDR" 0 7 "$EXPIRY" "$SIGNATURE" \
  --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-voucher.json" 2>&1
log "mintWithVoucher tx: $(txhash $DIR/tx-voucher.json)"
check "voucher mint -> token 21 to recipient" "$(cast call "$NFT" "ownerOf(uint256)" 21 --rpc-url "$RPC")" "$RECIPIENT_ADDR"
if cast send "$NFT" "mintWithVoucher(address,uint8,uint256,uint256,bytes)" \
  "$RECIPIENT_ADDR" 0 7 "$EXPIRY" "$SIGNATURE" \
  --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-replay.json" 2>&1; then
  log "FAIL replay protection — reused nonce minted!"; fail=$((fail+1))
else log "PASS replay protection — reused nonce reverted"; pass=$((pass+1)); fi

log "STEP 6 — holder path fail-closed, then opens after threshold set"
HSIG=$(cd "$API" && node -e "
const {signVoucher} = require('./lib/voucher.js');
const keys = require('$KEYS_JSON');
signVoucher(keys.voucher_signer.private_key, {
  chainId: $EXPECTED_CHAIN,
  contractAddress: '$NFT',
  recipient: '$RECIPIENT_ADDR',
  mintType: 1,
  nonce: 11,
  expiry: $EXPIRY,
}).then(s => console.log(s.trim()));")
if cast send "$NFT" "mintWithVoucher(address,uint8,uint256,uint256,bytes)" \
  "$RECIPIENT_ADDR" 1 11 "$EXPIRY" "$HSIG" \
  --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-holder-closed.json" 2>&1; then
  log "FAIL holder fail-closed — minted with no threshold!"; fail=$((fail+1))
else log "PASS holder fail-closed — reverted with no threshold"; pass=$((pass+1)); fi
cast send "$MOCK" "mint(address,uint256)" "$RECIPIENT_ADDR" 5000000000000000000000 --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > /dev/null 2>&1
cast send "$NFT" "setHolderThresholdMDOG(uint256)" 1000000000000000000000 --private-key "$SAFE_PK" --rpc-url "$RPC" > "$DIR/tx-threshold.json" 2>&1
log "setHolderThresholdMDOG tx: $(txhash $DIR/tx-threshold.json) (1000 mock MDOG; recipient holds 5000)"
HSIG2=$(cd "$API" && node -e "
const {signVoucher} = require('./lib/voucher.js');
const keys = require('$KEYS_JSON');
signVoucher(keys.voucher_signer.private_key, {
  chainId: $EXPECTED_CHAIN,
  contractAddress: '$NFT',
  recipient: '$RECIPIENT_ADDR',
  mintType: 1,
  nonce: 12,
  expiry: $EXPIRY,
}).then(s => console.log(s.trim()));")
cast send "$NFT" "mintWithVoucher(address,uint8,uint256,uint256,bytes)" \
  "$RECIPIENT_ADDR" 1 12 "$EXPIRY" "$HSIG2" \
  --private-key "$DEPLOYER_PK" --rpc-url "$RPC" > "$DIR/tx-holder.json" 2>&1
log "holder mint tx: $(txhash $DIR/tx-holder.json)"
check "holder mint -> token 22 to recipient" "$(cast call "$NFT" "ownerOf(uint256)" 22 --rpc-url "$RPC")" "$RECIPIENT_ADDR"

log "STEP 7 — voucher signer rotation"
NEWSIG_ADDR=$(cast wallet new --json | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['data'][0]['address'])")
cast send "$NFT" "setVoucherSigner(address)" "$NEWSIG_ADDR" --private-key "$SAFE_PK" --rpc-url "$RPC" > "$DIR/tx-signer.json" 2>&1
log "setVoucherSigner tx: $(txhash $DIR/tx-signer.json)"
check "signer rotation" "$(cast call "$NFT" "voucherSigner()" --rpc-url "$RPC")" "$NEWSIG_ADDR"

log "NFT-only rehearsal complete: $pass passed, $fail failed."
} 2>&1 | tail -45
