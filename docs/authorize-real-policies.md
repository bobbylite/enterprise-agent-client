# Real PingOne Authorize scaffold

Confirming Scaffold in PingOne mode builds a Trust Framework and the `Enterprise Agent Features` policy. It follows the bundled `pingone-authorize-ea-api-build` skill. Nothing in this repository contains an introspection secret.

## What Scaffold creates

Parent attribute `EnterpriseAgent`. These children use a `REQUEST` resolver and have no processor. Every resolver, including `REQUEST`, `SERVICE`, and `CONSTANT`, carries its own `valueType` on the create body, and that type matches the attribute. A later GET of a `REQUEST` or `SERVICE` resolver may omit `valueType`; the attribute's own `valueType` is what the read-back must show. Tokens are `STRING`. `risk-score` is `NUMBER`. Resolvers do not carry a processor. A `SERVICE` claim attribute puts the JSONPath processor on the attribute: `name` (for example `Extract introspection-groups`), `type: JSON_PATH`, `expression`, and `valueType`.

| Attribute | Type |
| --- | --- |
| `EnterpriseAgent.access-token` | STRING, the SSO access token |
| `EnterpriseAgent.tx-token` | STRING, the RFC 8693 token-exchanged token |
| `EnterpriseAgent.risk-level` | STRING |
| `EnterpriseAgent.risk-score` | NUMBER |
| `EnterpriseAgent.risk-action` | STRING |
| `EnterpriseAgent.admin-group` | STRING |

Definitions `introspect-client-id` and `introspect-client-secret` are constant attributes. Scaffold writes an empty value. Paste the custom-resource client id and secret in the PingOne console. The app never sends the secret.

Two top-level HTTP services, with no parent, POST `{authHost}/{environmentId}/as/introspect` as `application/x-www-form-urlencoded`. Authentication is `BASIC` and points at those Definition ids. The body is `token={{<attribute-uuid>}}`. `headers` is an empty array. Timeout is 3000ms. `maximumConcurrentRequests` is 20 and `maximumRequestsPerSecond` is 10. Value type is JSON. `cacheSettings`, a service-level processor, and `channel` are not sent: cache and processor are optional, and `channel` belongs to connector services.

- `EnterpriseAgent User Introspection` uses `access-token`.
- `EnterpriseAgent Delegation Introspection` uses `tx-token`.

Service attributes read `$.active`, `$.groups`, `$.sub`, and for the exchanged token `$.act.sub`, `$.aud`, and `$.scope`. Each processor is named `Extract <attribute>`, for example `Extract introspection-groups`.

The policy `Enterprise Agent Features` uses `DENY_OVERRIDES`. The decision is deny when either child denies. `INDETERMINATE` and `NOT_APPLICABLE` fail closed in the client. Scaffold creates that policy with one POST. The body is the whole tree: inline `Enterprise Agent User` and `Enterprise Agent Delegation` children, and each child's rules, conditions, and statements. A new child policy is `type: POLICY` with no id. A new rule is `type: RULE` with no id or version. A PUT of an existing policy does not create those children. On this API a PUT can return 200, leave `children` empty, and keep the same version. Copying an existing policy id into `children` does not move it. The shared Policies root is not a PUT target.

If a policy named `Enterprise Agent Features` already exists and a fresh GET shows both children and their rules, Scaffold leaves it alone. If that named policy exists but the tree is missing, Scaffold deletes only that policy and POSTs the tree. The name has to be unique, and a PUT cannot fill the shell.

The parent read has no expand parameter. It may return each child in full or as `{ type: POLICY, value: { id } }`. Scaffold follows the reference, then checks the child names and the rule payloads. Only after that fresh GET matches does it delete a leftover whose name is exactly `Enterprise Agent User` or `Enterprise Agent Delegation`, and only when that id is not one of the children just kept. A policy with any other name, including an older `Enterprise Agent` parent, is left in place. If the read-back does not match, Scaffold throws and does not delete those leftovers. The error and `~/Library/Logs/enterprise-agent-client/main.log` include the POST body, the raw GET, and each child as type, name, id, and value.id.

Dry run writes that same POST JSON to `authorize-policy-tree.json` in the app's user data folder (`~/Library/Application Support/enterprise-agent-client/` on macOS) and does not create, update, or delete anything in PingOne. Attribute ids that are not in PingOne yet appear as `{{name}}`.

1. **Enterprise Agent User** (`FIRST_APPLICABLE`). High risk, a `block` action, or an inactive access token denies. A `read_only` action permits a read-only feature payload. Membership of `access.adminGroup` in `$.groups` permits the full payload (`CONTAINS`, because a JSONPath filter that matches nobody throws and would stop the chain). An active token permits the session payload. There is no catch-all deny.
2. **Enterprise Agent Delegation** (`FIRST_APPLICABLE`). `authorize.delegations` is an allowlist of `humanSub`, `agentSub`, and optional `audience` and `scope`. The last rule permits when `tx-active` is `true` and `tx-act-sub` is not empty. `isApproved` is not used.

Rules travel in that same create POST. `effectSettings.type` is `UNCONDITIONAL_PERMIT` or `UNCONDITIONAL_DENY`. Each statement is an `EMBEDDED_STATEMENT` with code `enterprise-agent-features`, a static payload, `attributes: []`, and `services: []`. The create is read back with a new GET. A later run that already finds this tree does not write it again and does not delete leftovers.

Scaffold reads `GET /authorizationVersions?limit=25`. The list is `_embedded.items`, newest `createdAt` first. A policy change creates those versions; Scaffold does not POST one. It tags the newest with `PUT /authorizationVersions/{id}/tag`, or the version's `_links.tag.href`, then sets `authorizationVersion.id` on the `Enterprise Agent` decision endpoint. The same update sets `policy.id` to the `Enterprise Agent Features` policy. The endpoint id is stored locally and in `authorize.decisionEndpointId` when the config file is writable.

If that list has no usable version, Scaffold does not stop. It leaves the endpoint always-current, with no `authorizationVersion.id`, so the endpoint evaluates the latest policy. That mode is for development and debugging. The Policy tab shows the warning, and `~/Library/Logs/enterprise-agent-client/main.log` includes the raw versions response. `authorize.alwaysCurrent: true` also skips the fixed version. If the policy pointer does not stick, Scaffold keeps the endpoint and shows that too.

## Decision call

```json
{
  "parameters": {
    "EnterpriseAgent.access-token": "<SSO access token>",
    "EnterpriseAgent.tx-token": "<exchanged token>",
    "EnterpriseAgent.risk-level": "UNKNOWN",
    "EnterpriseAgent.risk-score": 0,
    "EnterpriseAgent.risk-action": "allow",
    "EnterpriseAgent.admin-group": "Administrator"
  },
  "userContext": { "user": { "id": "<user id>" } }
}
```

`risk-score` is a number. Every key above is always present. If either token is empty, the desktop client does not call PingOne.

`authorize.delegationAudience` chooses which exchanged audience is sent as `tx-token`. When it is empty, the first `tokenExchange.audiences` entry is used.

## PingOne setup

1. Create a custom resource that is the audience of the SSO access token, with a client secret and token introspection allowed. Use a second resource, or the same one, for the exchanged token.
2. Map group membership into the SSO access token `groups` claim, including `Administrator` (or `access.adminGroup`).
3. Configure RFC 8693 token exchange so the exchanged token includes `act.sub`, plus the audience and scope you want the delegation rules to see.
4. Give the worker application the Authorize roles for attributes, services, policies, versions, and decision endpoints.
5. Use Dry run policy tree on the Policy tab and read `authorize-policy-tree.json` before the first write. Then run Scaffold once.
6. In the PingOne console, paste the resource client id into `introspect-client-id` and the resource client secret into `introspect-client-secret`. Do not put that secret in `enterprise.json` or the git repo.
7. Optional: set `authorize.delegations` to the humans and agents that may be paired. Leave it empty to rely on the active-delegation rule.
8. Leave `isApproved` out of every rule until the human-in-the-loop flow in issue #20 is configured. A missing attribute throws and becomes a deny.
9. Trial licenses share a low configuration rate limit. Scaffold paces management writes and retries `429 REQUEST_LIMITED`. It does not retry `QUOTA_EXCEEDED`.

Reset local policy cache clears this computer's policy rows and saved Trust Framework ids. It does not delete the PingOne objects and it does not recreate them. Confirm Scaffold again to relink by name.
