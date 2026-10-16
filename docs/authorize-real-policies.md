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

User SSO introspection and delegation introspection use different clients. `user-introspect-client-id` and `user-introspect-client-secret` are the custom resource that issues the SSO access token. `introspect-client-id` and `introspect-client-secret` stay the enterprise agent client used for token exchange. Scaffold creates the user attributes when they are missing and updates `EnterpriseAgent User Introspection` so its BASIC auth points at them. The delegation service keeps the agent attributes. A later run does not delete or recreate a policy tree that already has its children and rules.

`authorize.userIntrospection.clientId` is the SSO resource client id. The secret is `PINGONE_USER_INTROSPECT_CLIENT_SECRET` or the Settings field, stored in the keychain as `userIntrospectClientSecret`. It is not a key in `enterprise.json`. When that secret or client id is set, Scaffold writes it onto the user Definition. An empty value does not wipe a secret already pasted in PingOne. Dry-run output, logs, and the decision trace never include the secret. Scaffold confirmation and dry run show the client id, the attribute names, and whether the secret is stored.

Two top-level HTTP services, with no parent, POST `{authHost}/{environmentId}/as/introspect` as `application/x-www-form-urlencoded`. Authentication is `BASIC` and points at those Definition ids. The body is `token={{<attribute-uuid>}}`. `headers` is an empty array. Timeout is 3000ms. `maximumConcurrentRequests` is 20 and `maximumRequestsPerSecond` is 10. Value type is JSON. `cacheSettings`, a service-level processor, and `channel` are not sent: cache and processor are optional, and `channel` belongs to connector services.

- `EnterpriseAgent User Introspection` uses `access-token` and the SSO resource Definitions `user-introspect-client-id` and `user-introspect-client-secret`.
- `EnterpriseAgent Delegation Introspection` uses `tx-token` and the enterprise agent Definitions `introspect-client-id` and `introspect-client-secret`.

Service attributes read `$.active`, `$.groups`, `$.sub`, and for the exchanged token `$.act.sub`, `$.aud`, and `$.scope`. Each processor is named `Extract <attribute>`, for example `Extract introspection-groups`.

The policy `Enterprise Agent Features` uses `DENY_OVERRIDES`. The decision is deny when either child denies. `INDETERMINATE` and `NOT_APPLICABLE` fail closed in the client. Scaffold creates that policy with one POST. The body is the whole tree: inline `Enterprise Agent User` and `Enterprise Agent Delegation` children, and each child's rules, conditions, and statements. A new child policy is `type: POLICY` with no id. A new rule is `type: RULE` with no id or version. A PUT of an existing policy does not create those children. On this API a PUT can return 200, leave `children` empty, and keep the same version. Copying an existing policy id into `children` does not move it. The shared Policies root is not a PUT target.

If a policy named `Enterprise Agent Features` already exists and a fresh GET shows both children and their rules, Scaffold leaves it alone. If that named policy exists but the tree is missing, Scaffold deletes only that policy and POSTs the tree. The name has to be unique, and a PUT cannot fill the shell.

The parent read has no expand parameter. It may return each child in full or as `{ type: POLICY, value: { id } }`. Scaffold follows the reference, then checks the child names and the rule payloads. Only after that fresh GET matches does it delete a leftover whose name is exactly `Enterprise Agent User` or `Enterprise Agent Delegation`, and only when that id is not one of the children just kept. A policy with any other name, including an older `Enterprise Agent` parent, is left in place. If the read-back does not match, Scaffold throws and does not delete those leftovers. The error and `~/Library/Logs/enterprise-agent-client/main.log` include the POST body, the raw GET, and each child as type, name, id, and value.id.

Dry run writes that same POST JSON to `authorize-policy-tree.json` in the app's user data folder (`~/Library/Application Support/enterprise-agent-client/` on macOS) and does not create, update, or delete anything in PingOne. Attribute ids that are not in PingOne yet appear as `{{name}}`. The Policy tab also shows which introspection client each service will use. That note includes the SSO client id and never the secret.

1. **Enterprise Agent User** (`FIRST_APPLICABLE`). High risk, a `block` action, or an inactive access token denies. A `read_only` action permits a read-only feature payload. Membership of `access.adminGroup` in `$.groups` permits the full payload (`CONTAINS`, because a JSONPath filter that matches nobody throws and would stop the chain). An active token permits the session payload. There is no catch-all deny.
2. **Enterprise Agent Delegation** (`FIRST_APPLICABLE`). `authorize.delegations` is an allowlist of `humanSub`, `agentSub`, and optional `audience` and `scope`. The last rule permits when `tx-active` is `true` and `tx-act-sub` is not empty. `isApproved` is not used.

Rules travel in that same create POST. `effectSettings.type` is `UNCONDITIONAL_PERMIT` or `UNCONDITIONAL_DENY`. Each statement is an `EMBEDDED_STATEMENT` with code `enterprise-agent-features`, a static payload, `attributes: []`, and `services: []`. The create is read back with a new GET. A later run that already finds this tree does not write it again and does not delete leftovers.

Scaffold tags the latest authorization version and sets `authorizationVersion.id` on the `Enterprise Agent` decision endpoint. `authorize.alwaysCurrent: true` skips that attachment and is only for development. The endpoint id is stored locally and in `authorize.decisionEndpointId` when the config file is writable.

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

1. Create a custom resource that is the audience of the SSO access token, with a client secret and token introspection allowed. That resource's client id and secret are the user introspection credentials. Use the enterprise agent (token exchange) application for the exchanged token. Do not point user introspection at the enterprise agent client: PingOne then returns `active: false` for the SSO token.
2. Map group membership into the SSO access token `groups` claim, including `Administrator` (or `access.adminGroup`).
3. Configure RFC 8693 token exchange so the exchanged token includes `act.sub`, plus the audience and scope you want the delegation rules to see.
4. Give the worker application the Authorize roles for attributes, services, policies, versions, and decision endpoints.
5. Use Dry run policy tree on the Policy tab and read `authorize-policy-tree.json` before the first write. Then run Scaffold once.
6. Put the SSO resource client id in `authorize.userIntrospection.clientId`. Put its secret in `PINGONE_USER_INTROSPECT_CLIENT_SECRET` or Settings. Leave `introspect-client-id` and `introspect-client-secret` for the enterprise agent client. Do not put either secret in `enterprise.json` or the git repo. If you paste values in the PingOne console instead, use the attribute names above.
7. Optional: set `authorize.delegations` to the humans and agents that may be paired. Leave it empty to rely on the active-delegation rule.
8. Leave `isApproved` out of every rule until the human-in-the-loop flow in issue #20 is configured. A missing attribute throws and becomes a deny.
9. Trial licenses share a low configuration rate limit. Scaffold paces management writes and retries `429 REQUEST_LIMITED`. It does not retry `QUOTA_EXCEEDED`.

Reset local policy cache clears this computer's policy rows and saved Trust Framework ids. It does not delete the PingOne objects and it does not recreate them. Confirm Scaffold again to relink by name.
