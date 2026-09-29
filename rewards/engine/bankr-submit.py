#!/usr/bin/env python3
"""Submit a prebuilt transaction via Bankr POST /wallet/submit.

Reads the submit payload as JSON from stdin, authenticates with the stored
custom.bankr connector credential (surrogate swapped server-side; the raw key
never appears here), and prints the JSON response.

Payload shape:
    {"transaction": {"to": "0x...", "chainId": 4663, "value": "0", "data": "0x..."},
     "description": "human-readable label",
     "waitForConfirmation": true}
"""
import json
import sys
import urllib.request

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import (
    add_surrogate_to_request,
    read_json_response,
    DynamicCredentialError,
)

API_BASE = "https://api.bankr.bot"
ALLOWED = ["api.bankr.bot"]
CREDENTIAL = "custom.bankr"


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"success": False, "error": f"bad stdin JSON: {e}"}))
        sys.exit(2)
    req = urllib.request.Request(
        API_BASE + "/wallet/submit",
        data=json.dumps(payload).encode(),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    try:
        add_surrogate_to_request(req, CREDENTIAL, allowed_hosts=ALLOWED)
    except DynamicCredentialError as e:
        print(json.dumps({"success": False, "error": f"auth error: {e}"}))
        sys.exit(3)
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            print(json.dumps(read_json_response(resp), indent=2))
    except Exception as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:1000]
        except Exception:
            pass
        msg = f"{e} {body}".strip()
        print(json.dumps({"success": False, "error": msg}))
        sys.exit(1)


if __name__ == "__main__":
    main()
