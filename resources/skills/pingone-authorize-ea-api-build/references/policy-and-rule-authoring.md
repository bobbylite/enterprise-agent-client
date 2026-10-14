# Policy & Rule Authoring — AAM Custom Placement + API Workflow

## Step 1 — Read the target Custom node before choosing placement

The old console-only guidance was too broad. The reliable rule is: **never use POST-with-parent for AAM placement**, but a full PUT of a managed Custom container may be able to create its child policy when the container advertises `disallowChildren: false`.

First GET the target Custom node:

```http
GET /v1/environments/{envId}/authorizationPolicies/{customNodeId}
```

Check:

```json
{
  "id": "<custom-node-id>",
  "version": "<current-version>",
  "managedEntity": {
    "restrictions": {
      "readOnly": true,
      "disallowChildren": false
    }
  },
  "children": []
}
```

## Step 2 — Preferred live-confirmed placement route when `disallowChildren` is false

**Live-confirmed in a private test tenant on 2026-08-31.** A full `PUT` directly on the managed Custom node created a writable child policy without a console-created skeleton. Preserve the current Custom `id`, `version`, `name`, `enabled`, and `combiningAlgorithm`; replace the `children` array with the new policy:

```json
{
  "id": "<custom-node-id>",
  "version": "<fresh-custom-version>",
  "name": "Custom",
  "enabled": true,
  "combiningAlgorithm": {"algorithm": "DENY_OVERRIDES"},
  "children": [
    {
      "type": "POLICY",
      "name": "example-aam-policy",
      "description": "Checkpoint 2 policy",
      "combiningAlgorithm": {"algorithm": "DENY_OVERRIDES"},
      "enabled": true,
      "children": []
    }
  ]
}
```

After the PUT, GET both the Custom node and the newly assigned child policy. Confirm the child appears in `Custom.children`, its `_links.parent` points to the Custom node, and it is not managed — either the `managedEntity` block is absent or it reads `managedEntity: false`. Test for "not managed" rather than for a literal `false`. Only then PUT the child policy with its rules/statements.

This is live-confirmed behavior, not a universal platform guarantee. If `disallowChildren` is true, or the PUT returns a constraint error, stop and use the console shell fallback below. Always preserve the complete existing child list; `children` is a full replacement, not an append.

**Scope this to the Custom node itself.** An earlier attempt to write the same kind of tree change by PUTting the AAM **root** policy with the full tree plus injected children returned a server-side `UNEXPECTED_ERROR`. The confirmed route is a PUT targeted at the Custom node, not at an ancestor. Do not widen the target on the assumption that a larger PUT behaves the same way.

## Step 3 — POST-with-parent is not a placement mechanism

`POST /authorizationPolicies` with `parent: {"id": "<custom-node-id>"}` remains unsafe. It may return HTTP 201 but place the new policy under the flat shared `Policies` root instead. In the live test, the returned policy's parent link pointed to the shared `Policies` root, while a subsequent GET of the Custom node showed no child. Delete any such probe policy after confirming the misplacement.

## Step 4 — Console shell fallback (one time per location)

If the Custom node disallows children or the direct PUT route is rejected:

**You cannot place a new policy into a managed AAM Custom node via POST.** Use the console fallback:

1. Console → Authorize → API Services → `<your API Server>`
2. Expand Operation → Inbound Request (or Outbound Response) → Custom
3. Click **+ Add Policy** (or equivalent)
4. Save without adding rules/statements
5. GET the tree and continue with API PUTs against the now-writable child policy

This is not a case for repeated POST experiments. The console shell remains the supported fallback.

Every managed AAM Operation has this tree shape:

```
Operation "get-vendor-contract"  [managed, readOnly]
  └─ Inbound Request             [managed, readOnly]
       ├─ Basic Rules            [managed, readOnly]
       └─ Custom                 [managed, readOnly]   ← target
```

**Console steps (one per Operation/location that needs a policy):**
1. Console → Authorize → API Services → `<your API Server>`
2. Expand Operation → Inbound Request (or Outbound Response) → Custom
3. Click **+ Add Policy** (or the equivalent "+" control) — name it anything
4. Save. Do not add rules or statements in the console — everything from here is API-driven.

Once this shell exists, it has `managedEntity: false` and is **fully writable via API** — this is the key unlock. The managed boundary is exactly one level deep: you cannot cross *into* a managed node via API, but anything non-managed already placed inside one is entirely yours.

If instead you're authoring a free-standing policy in the general `Policies` library (not bound to a specific Operation's Custom node), you can `POST` it directly via the documented non-AAM API — no console step needed:

```http
POST /v1/environments/{envId}/authorizationPolicies
```

Create body:

```json
{
  "type": "POLICY",
  "name": "example-policy",
  "description": "Example",
  "combiningAlgorithm": {"algorithm": "DENY_OVERRIDES"},
  "enabled": true,
  "children": []
}
```

Every policy created through this endpoint is nested under the one existing, environment-wide shared `Policies` root. The EA documentation does not define an independent root/Policy Set creation type or route; do not guess at `POLICY_SET`, `ROOT`, or a similar alternate `type`. The console-only step is specifically for placement into a managed AAM tree location. A direct Decision Endpoint is a separate non-AAM resource; see `decision-endpoints.md` for its create/evaluate and version tag/attach lifecycle.

## Step 5 — Discover the child/shell policy's UUID

Walk the tree from the Decision Endpoint's root policy, or use `scripts/walk_policy_tree.py`:

```bash
TOKEN=<worker-app-bearer-token>
ENV=<environment-id>
ROOT_POLICY_ID=<de-root-policy-id>   # from GET /decisionEndpoints/{deId} -> policy.id when exposed; direct endpoints may instead expose authorizationVersion.id

curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.pingone.com/v1/environments/${ENV}/authorizationPolicies/${ROOT_POLICY_ID}" \
  | python3 -c "
import sys,json
def walk(n, d=0):
    print('  '*d + n.get('id','') + '  ' + n.get('name',''))
    for c in n.get('children',[]): walk(c,d+1)
walk(json.load(sys.stdin))
"
```

Find your shell policy's UUID as a child of the `Custom` node under your Operation. For a direct non-AAM Decision Endpoint, do not assume this tree-walking route applies: its response may omit `policy.id`, and an attached `authorizationVersion.id` is the authoritative link. A child policy tree alone does not prove the effective root or combining behavior.

## Step 6 — GET the child/shell policy for version fields

PUT requires **two separate version fields** if you're updating an existing rule: the parent policy's own `version`, and (if updating rather than creating) the rule's own `version`. Both only come from a fresh GET — always re-GET immediately before every PUT, since version changes on every successful write.

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.pingone.com/v1/environments/${ENV}/authorizationPolicies/${SHELL_POLICY_ID}"
```

Key fields: `id`, `version` (policy-level), `children[0].id` and `children[0].version` (if a rule already exists and you're editing it).

**Rules are not standalone, individually-addressable API resources.** `GET /authorizationPolicies/{rule-id}` returns `NOT_FOUND` for a rule UUID — even one you just saw embedded in a parent's `children` array. `POST /authorizationPolicies` with `"type": "RULE"` returns `"Invalid type id"`. **The only way to create, modify, or delete a rule is to PUT the entire parent policy with an updated `children` array.**

## Step 7 — PUT the policy with rule(s) and statement(s)

```python
import json, urllib.request

STATEMENTS = [
  {
    "name": "verify-personSub",
    "code": "modify-query",
    "obligatory": True,
    "appliesTo": "ANYTHING",
    "appliesIf": "PATH_MATCHES",
    "attributes": [],   # leave empty -- see SKILL.md "payload string vs attributes array trap"
    "payload": "{\"personSub\": \"{{<attribute-uuid>}}\"}"
  },
]

rule = {
    "type": "RULE",                                # REQUIRED on write; GET responses omit it entirely -- see gotcha table below
    "id": "<existing-rule-uuid>",                   # omit entirely if creating a NEW rule
    "version": "<existing-rule-version>",           # omit entirely if creating a NEW rule
    "name": "my-rule-name",
    "enabled": True,
    "effectSettings": {"type": "UNCONDITIONAL_PERMIT"},   # yes, even for conditional rules -- see below
    "condition": {"type": "EMPTY"},                 # or a real AND/COMPARISON condition -- see condition shape below
    "statements": STATEMENTS
}

# Build PUT body from a fresh GET -- strip read-only/server-managed fields
put_body = {k: current[k] for k in current if not k.startswith('_')}
for drop in ('environment', 'managedEntity', 'parent'):
    put_body.pop(drop, None)
put_body['children'] = [rule]   # full replacement of children array, not an append

req = urllib.request.Request(
    f"https://api.pingone.com/v1/environments/{ENV}/authorizationPolicies/{SHELL_POLICY_ID}",
    data=json.dumps(put_body).encode(), method='PUT',
    headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
)
with urllib.request.urlopen(req) as r:
    result = json.loads(r.read())
```

**The `children` array is a full replacement, not a merge/append.** If the policy already has other rules you want to keep, include them (with their existing `id`/`version`) alongside the new one in the same array.

For direct Decision Endpoint parameters, use a normal non-AAM Trust Framework parent (for example, `Example`) and a processor-free `REQUEST` attribute. The request parameter key must literally be that attribute's full name and the JSON type must match `valueType`; do not add a JSONPath processor after the request resolver, because it attempts to reparse the resolved scalar and can produce `TYPE_CONVERSION_ERROR`. See `resolvers-and-attributes.md` for the complete recipe.

### Real conditional rule shape

```json
"condition": {
  "type": "AND",
  "conditions": [{
    "type": "COMPARISON",
    "left": {"type": "ATTRIBUTE", "id": "<attribute-uuid>"},
    "comparator": "EQUALS",
    "right": {"type": "CONSTANT", "value": "raw_materials"}
  }]
}
```

**Read `condition-evaluation-and-nulls.md` before writing any conditional rule** — a condition referencing an attribute that's missing (not empty, missing) on the evaluated entity throws and DENIES rather than evaluating false.

## Every field that differs from a naive guess (all confirmed via live GET/PUT testing)

| Field | Wrong guess | Correct value |
|---|---|---|
| `type` on a rule child | (often omitted, since GET doesn't show it) | `"RULE"` — **required on write, silently stripped on read.** GET responses for existing rules never include `type`; you must add it back yourself for any child you're writing, new or existing. |
| `effectSettings.type` for a conditional rule | `"CONDITIONAL_PERMIT"` | `"UNCONDITIONAL_PERMIT"` — always, even when the rule has a real condition. The effect is always PERMIT or DENY; conditionality lives entirely in the `condition` field, not `effectSettings`. |
| `condition.type` for a boolean AND | `"CONDITION_SET"` | `"AND"` |
| the AND's combining field | `"conditionSetAlgorithm"` | does not exist as a field — don't send it |
| `right.type` inside a COMPARISON | `"VALUE"` | `"CONSTANT"` |
| policy `version` on PUT | omittable | **required** — omitting returns `"version must not be null"` |
| rule `version` when updating an existing rule | omittable | **required if the rule already exists** — omitting returns `CONSTRAINT_VIOLATION: An attempt was made to update an outdated version` |
| policy `id` in the PUT body | URL alone is enough | **must also be in the body** — omitting returns `"id must not be null"` |

## Step 8 — Deploy or attach, depending on resource type

For a direct non-AAM Decision Endpoint, do not use the AAM API Server deployment route. Tag the policy authorization version with `PUT /authorizationVersions/{versionId}/tag`, attach it through the endpoint's `authorizationVersion.id`, then GET the endpoint and perform a live decision call. See `decision-endpoints.md`.

For AAM API Servers, continue with the deployment mechanics below.

A successful PUT changes the policy object, but the Decision Endpoint keeps serving whatever `authorizationVersion` was last deployed. Nothing is live until deploy happens.

`POST /environments/{envId}/apiServers/{apiServerId}/deployment` with a **Worker app Bearer token works** — HTTP 200 and a new `authorizationVersionId` (confirmed 2026-08-16). An earlier revision of this skill said AAM API Servers required the console deploy button or a gateway `client-token`; that is disproven. The console button remains a valid fallback, not a requirement. See `ea-api-operational-quirks.md` for the full deploy mechanics.

**Verification, always:** after deploy, `GET /environments/{envId}/apiServers/{apiServerId}/deployment` and confirm `authorizationVersionId` actually changed from its pre-deploy value. If it didn't change, the deploy was effectively a no-op (e.g. the policy hash matched what was already deployed) and nothing new is live — don't trust a sideband test until this is confirmed.
