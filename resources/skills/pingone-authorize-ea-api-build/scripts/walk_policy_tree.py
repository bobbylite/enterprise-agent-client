#!/usr/bin/env python3
"""
walk_policy_tree.py — Walk a PingOne Authorize policy tree and print every
node's id, name, and depth.

Useful for:
  - Locating a child/shell policy's UUID after creating it (Step 5 of the
    placement workflow in references/policy-and-rule-authoring.md), whether it
    was created by the Custom-node PUT canary or the console fallback
  - Getting oriented in an unfamiliar policy tree
  - Confirming a PUT actually landed where you expected (re-run after a write)

Usage:
    python3 walk_policy_tree.py <env-id> <root-policy-id> <bearer-token>

    Or set environment variables and omit args:
    PINGONE_ENV_ID, PINGONE_ROOT_POLICY_ID, PINGONE_BEARER_TOKEN

To find a root-policy-id for an AAM or otherwise root-exposing endpoint: GET
`/decisionEndpoints/{deId}` and read the `policy.id` field when present. A direct
Decision Endpoint may omit `policy.id`; use its attached `authorizationVersion.id`
as the authoritative endpoint link and inspect the corresponding version package.
A child policy tree alone does not prove effective-root or combining behavior.

Note: this walks whatever tree is reachable from the given root policy ID.
It does NOT distinguish managed (readOnly) nodes from your own writable
policies in its output -- cross-reference against managedEntity.restrictions
in a raw GET if you need that distinction for a specific node.
"""
import sys
import os
import json
import urllib.request
import urllib.error


def fetch_policy(env_id: str, policy_id: str, token: str) -> dict:
    url = f"https://api.pingone.com/v1/environments/{env_id}/authorizationPolicies/{policy_id}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        print(f"ERROR fetching {policy_id}: HTTP {e.code}\n{body}", file=sys.stderr)
        raise


def walk(node: dict, depth: int = 0) -> None:
    node_id = node.get("id", "<no-id>")
    name = node.get("name", "<unnamed>")
    node_type = node.get("type", "")
    managed = node.get("managedEntity", {})
    is_readonly = bool(managed.get("restrictions", {}).get("readOnly", False)) if isinstance(managed, dict) else False
    marker = " [readOnly]" if is_readonly else ""
    print("  " * depth + f"{node_id}  {name}" + (f"  ({node_type})" if node_type else "") + marker)
    for child in node.get("children", []):
        walk(child, depth + 1)


def main() -> None:
    if len(sys.argv) >= 4:
        env_id, root_policy_id, token = sys.argv[1], sys.argv[2], sys.argv[3]
    else:
        env_id = os.environ.get("PINGONE_ENV_ID")
        root_policy_id = os.environ.get("PINGONE_ROOT_POLICY_ID")
        token = os.environ.get("PINGONE_BEARER_TOKEN")

    if not (env_id and root_policy_id and token):
        print(__doc__)
        sys.exit(1)

    root = fetch_policy(env_id, root_policy_id, token)
    walk(root)


if __name__ == "__main__":
    main()
