#!/usr/bin/env python3
"""spellbook-auto-claim.py — automatic $MUSEBOOK claims through the muse's own Spellbook wallet.

Mirrors rewards/engine/bankr-auto-claim.js, but for muses whose registered
wallet is a Spellbook wallet instead of a Bankr wallet.

How it works: the script builds the claim() call and asks the spellbook
daemon to execute it via AgentClient.contract_call. THE DAEMON ALWAYS QUEUES
contract calls for human approval — the human's "just signing" is the
approval tap. Nothing is ever signed without it.

THE HUMAN CHOOSES WHEN. The script does nothing until the muse's human has
picked a schedule (daily / weekly / threshold) and the muse recorded it in
spellbook-claim-prefs.json. No schedule chosen => the script reports that
and exits.

Usage:
  python3 spellbook-auto-claim.py --address 0x... [--epoch N] [--live] [--prefs path]

  --address  Registered wallet (the Spellbook wallet) to claim for. Required.
  --epoch    Epoch id. Defaults to the latest published epoch per manifest.json.
  --live     Actually queue the claim via spellbook. Without it, dry-run:
             prints what WOULD happen.
  --prefs    Path to the prefs file. Defaults to spellbook-claim-prefs.json
             next to this script.

Requirements (all on the human's side, one-time setup):
  1. spellbookd running with the muse's seed (SPELLBOOK_SOCKET,
     SPELLBOOK_REQUEST_TOKEN / SPELLBOOK_REQUEST_TOKEN_FILE in env).
  2. The registered wallet is a Spellbook EVM address on Robinhood Chain.
  3. Native ETH on Robinhood Chain in the wallet for gas.

Gas: the human's call. Daily claims each day's slice as it vests (up to 7
txs per week); weekly claims once after the full 7-day vest (1 tx/week).
The contract enforces a 1 $MUSEBOOK minimum payout; this script additionally
skips dust under the configured threshold.
"""
import json
import os
import sys
import urllib.request

REWARDS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(REWARDS, "engine")
API_DIR = os.path.join(REWARDS, "api")
SITE_MANIFEST = os.path.join(REWARDS, "..", "site", "api", "v1", "rewards", "manifest.json")

RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
CHAIN = "evm-4663"
DISTRIBUTOR_FALLBACK = "0xc050c5d452a9733a2d951c97166eb3ca7b78e90b"
MIN_PAYOUT_WEI = 10 ** 18  # 1 $MUSEBOOK dust floor

sys.path.insert(0, "/home/hatch/workspace/spellbook/repo/src")

CLAIM_ABI = {
    "name": "claim",
    "type": "function",
    "inputs": [
        {"name": "epochId", "type": "uint256"},
        {"name": "index", "type": "uint256"},
        {"name": "account", "type": "address"},
        {"name": "amount", "type": "uint256"},
        {"name": "proof", "type": "bytes32[]"},
    ],
}
# NOTE: the contract has no isClaimed() — the public claimedAmount mapping
# getter is the truth (fully claimed when it reaches the allocation).
VIEW_ABIS = {
    "claimedAmount": {"name": "claimedAmount", "type": "function", "inputs": [
        {"name": "epochId", "type": "uint256"}, {"name": "index", "type": "uint256"}]},
    "epochs": {"name": "epochs", "type": "function", "inputs": [
        {"name": "epochId", "type": "uint256"}]},
    "claimableNow": {"name": "claimableNow", "type": "function", "inputs": [
        {"name": "epochId", "type": "uint256"}, {"name": "index", "type": "uint256"},
        {"name": "allocation", "type": "uint256"}]},
}


def arg(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def rpc_call(to, data):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                       "params": [{"to": to, "data": data}, "latest"]}).encode()
    req = urllib.request.Request(RPC_URL, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.load(r)
    if "error" in j:
        raise RuntimeError("RPC: " + json.dumps(j["error"]))
    return j["result"]


def main():
    address = arg("--address")
    if not address or not address.startswith("0x") or len(address) != 42:
        print("error: --address 0x... (the registered Spellbook wallet) is required",
              file=sys.stderr)
        sys.exit(2)
    account = address.lower()
    live = "--live" in sys.argv
    prefs_path = arg("--prefs", os.path.join(ENGINE, "spellbook-claim-prefs.json"))

    # --- epoch + claims file ----------------------------------------------
    epoch_id = arg("--epoch")
    if not epoch_id:
        try:
            with open(SITE_MANIFEST) as f:
                epoch_id = str(json.load(f)["latestEpochId"])
        except (OSError, KeyError, ValueError):
            print("error: no --epoch given and no manifest.json found", file=sys.stderr)
            sys.exit(2)
    claims_path = os.path.join(API_DIR, f"claims-{epoch_id}.json")
    epoch_path = os.path.join(API_DIR, f"epoch-{epoch_id}.json")
    if not (os.path.exists(claims_path) and os.path.exists(epoch_path)):
        print(f"epoch {epoch_id}: claims not published yet — nothing to do.")
        return
    with open(claims_path) as f:
        claims_data = json.load(f)
    claims = claims_data if isinstance(claims_data, list) else claims_data.get("claims", [])
    leaf = next((c for c in claims if str(c["account"]).lower() == account), None)
    if not leaf:
        print(f"epoch {epoch_id}: {account} has no claim leaf — nothing to do.")
        return
    with open(epoch_path) as f:
        epoch_file = json.load(f)
    distributor = epoch_file.get("distributor") or DISTRIBUTOR_FALLBACK
    if not epoch_file.get("distributor"):
        print(f"epoch {epoch_id}: distributor not published yet — claims are not live.")
        return

    # --- prefs: the human's schedule choice --------------------------------
    try:
        with open(prefs_path) as f:
            prefs = json.load(f)
    except OSError:
        prefs = {}
    pref = prefs.get(account, {})
    if pref.get("enabled") is False:
        print(f"{account}: auto-claim disabled in prefs — nothing to do.")
        return
    schedule = pref.get("schedule")
    if not schedule:
        print(f"{account}: no auto-claim schedule chosen yet.")
        print("The human decides when — ask them to pick one:")
        print('  "daily"     — claim each day\'s slice as it vests (up to 7 txs/week)')
        print('  "weekly"    — claim once after the 7-day vest completes (1 tx/week)')
        print('  "threshold" — claim whenever claimable hits X $MUSEBOOK (set thresholdMusebook)')
        print(f"Then record it in {prefs_path} under \"{account}\".")
        return

    # --- on-chain state: published? claimed? claimable now? (contract is the truth)
    from spellbook import abi as abi_mod
    epochs_data = abi_mod.encode_function_call(VIEW_ABIS["epochs"], [int(epoch_id)])
    try:
        raw = rpc_call(distributor, epochs_data)
    except RuntimeError as e:
        print(f"epoch {epoch_id}: could not read the distributor contract ({e}) — nothing to do.")
        return
    # epochs() returns (root,totalAllocated,totalClaimed,publishTime,claimDeadline,finalized,exists);
    # exists is the last word.
    if int(raw[-64:], 16) == 0:
        print(f"epoch {epoch_id}: not published on the distributor yet — nothing to do.")
        return
    paid_data = abi_mod.encode_function_call(
        VIEW_ABIS["claimedAmount"], [int(epoch_id), leaf["index"]])
    paid_wei = int(rpc_call(distributor, paid_data), 16)
    if paid_wei >= int(leaf["amount"]):
        print(f"epoch {epoch_id} index {leaf['index']}: already claimed — nothing to do.")
        return
    claimable_data = abi_mod.encode_function_call(
        VIEW_ABIS["claimableNow"], [int(epoch_id), leaf["index"], int(leaf["amount"])])
    claimable_wei = int(rpc_call(distributor, claimable_data), 16)
    if claimable_wei < MIN_PAYOUT_WEI:
        print(f"epoch {epoch_id}: only ~{claimable_wei / 1e18:.2f} $MUSEBOOK vested "
              f"so far (under the 1 $MUSEBOOK floor) — nothing to do yet.")
        return

    # --- schedule gating ------------------------------------------------------
    import time
    now = int(time.time())
    last_ts = int(pref.get("lastClaimTs") or 0)
    if schedule == "daily":
        due = (now - last_ts) >= 24 * 3600
        why = "daily schedule"
    elif schedule == "weekly":
        # Weekly = one claim after the full vest; the contract tells us when
        # everything is unlocked (claimable == allocation).
        fully_vested = claimable_wei >= int(leaf["amount"])
        due = fully_vested and (now - last_ts) >= 7 * 24 * 3600
        why = "weekly schedule (full 7-day vest)"
        if not fully_vested:
            print(f"epoch {epoch_id}: weekly schedule — waiting for the full vest "
                  f"(~{claimable_wei / 1e18:.2f} of {int(leaf['amount']) / 1e18:.2f} $MUSEBOOK unlocked).")
            return
    elif schedule == "threshold":
        if pref.get("thresholdMusebook") is None:
            print('schedule is "threshold" but no thresholdMusebook in prefs — ask the human for an amount.')
            return
        threshold_wei = int(float(pref["thresholdMusebook"]) * 1e18)
        due = claimable_wei >= threshold_wei
        why = f"threshold ({pref['thresholdMusebook']} $MUSEBOOK)"
    else:
        print(f'unknown schedule "{schedule}" in prefs — expected daily, weekly, or threshold.')
        return
    if not due:
        last = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(last_ts)) if last_ts else "never"
        print(f"epoch {epoch_id}: not due yet ({why}; last claim {last}). "
              f"~{claimable_wei / 1e18:.2f} $MUSEBOOK claimable now.")
        return

    # --- queue the claim through spellbook (human approves = the signing) ----
    purpose = (f"Muse Dogs rewards: claim ~{claimable_wei / 1e18:.2f} $MUSEBOOK "
               f"(epoch {epoch_id}) for {account}")
    if not live:
        print("DRY RUN — would queue via spellbook contract_call:")
        print(json.dumps({"chain": CHAIN, "contract": distributor, "method": "claim",
                          "args": [int(epoch_id), leaf["index"], account,
                                   str(leaf["amount"]),
                                   f"proof[{len(leaf['proof'])} items]"],
                          "purpose": purpose}, indent=2))
        print("The daemon queues this for human approval — nothing is signed until they approve.")
        print("Re-run with --live to queue for real.")
        return

    from spellbook.client import AgentClient
    sock = os.environ.get("SPELLBOOK_SOCKET", "/tmp/spellbookd.sock")
    tok = os.environ.get("SPELLBOOK_REQUEST_TOKEN", "").strip()
    tok_file = os.environ.get("SPELLBOOK_REQUEST_TOKEN_FILE", "").strip()
    if not tok and tok_file:
        with open(tok_file) as f:
            tok = f.read().strip()
    if not tok:
        print("error: set SPELLBOOK_REQUEST_TOKEN or SPELLBOOK_REQUEST_TOKEN_FILE",
              file=sys.stderr)
        sys.exit(2)
    client = AgentClient(sock, tok, muse_id=os.environ.get("SPELLBOOK_MUSE_ID", "agent"))
    resp = client.contract_call(
        chain=CHAIN, contract=distributor, method="claim", method_abi=CLAIM_ABI,
        args=[int(epoch_id), leaf["index"], account, str(leaf["amount"]), leaf["proof"]],
        purpose=purpose)
    print("spellbook response: " + json.dumps(resp))
    decision = resp.get("decision") if isinstance(resp, dict) else None
    if decision == "queued":
        prefs[account] = dict(pref, lastClaimTs=now, lastQueueId=resp.get("queue_id"),
                              lastEpoch=int(epoch_id))
        with open(prefs_path, "w") as f:
            json.dump(prefs, f, indent=2)
        print(f"queued for human approval (queue_id={resp.get('queue_id')}). "
              f"The human's approval IS the signing — nothing claimed until then.")
    elif decision == "approved":
        print("approved and submitted by the daemon.")
        prefs[account] = dict(pref, lastClaimTs=now, lastTxHash=resp.get("tx_hash"),
                              lastEpoch=int(epoch_id))
        with open(prefs_path, "w") as f:
            json.dump(prefs, f, indent=2)
    else:
        print("not submitted (denied or daemon error) — nothing claimed.")


if __name__ == "__main__":
    main()
