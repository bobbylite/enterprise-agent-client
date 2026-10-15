# Real PingOne Authorize scaffold

Confirming Scaffold in PingOne mode builds a Trust Framework and two policies. It follows the bundled `pingone-authorize-ea-api-build` skill. Nothing in this repository contains an introspection secret.

## What Scaffold creates

Parent attribute `EnterpriseAgent`. These children use a `REQUEST` resolver and have no processor. Every resolver, including `REQUEST`, `SERVICE`, and `CONSTANT`, carries its own `valueType` on the create body, and that type matches the attribute. A later GET of a `REQUEST` or `SERVICE` resolver may omit `valueType`; the attribute's own `valueType` is what the read-back must show. Tokens are `STRING`. `risk-score` is `NUMBER`.

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

Service attributes read `$.active`, `$.groups`, `$.sub`, and for the exchanged token `$.act.sub`, `$.aud`, and `$.scope`.

The parent policy `Enterprise Agent` uses `DENY_OVERRIDES`. The decision is deny when either child denies. `INDETERMINATE` and `NOT_APPLICABLE` fail closed in the client.

1. **Enterprise Agent User** (`FIRST_APPLICABLE`). High risk, a `block` action, or an inactive access token denies. A `read_only` action permits a read-only feature payload. Membership of `access.adminGroup` in `$.groups` permits the full payload (`CONTAINS`, because a JSONPath filter that matches nobody throws and would stop the chain). An active token permits the session payload. There is no catch-all deny.
2. **Enterprise Agent Delegation** (`FIRST_APPLICABLE`). `authorize.delegations` is an allowlist of `humanSub`, `agentSub`, and optional `audience` and `scope`. The last rule permits when `tx-active` is `true` and `tx-act-sub` is not empty. `isApproved` is not used.

Rules are a full PUT of the policy, including `id` and `version`, `type: RULE`, and `effectSettings.type` of `UNCONDITIONAL_PERMIT` or `UNCONDITIONAL_DENY`. Statement code `enterprise-agent-features` uses a static payload and `attributes: []`. Each write is read back.

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

1. Create a custom resource that is the audience of the SSO access token, with a client secret and token introspection allowed. Use a second resource, or the same one, for the exchanged token.
2. Map group membership into the SSO access token `groups` claim, including `Administrator` (or `access.adminGroup`).
3. Configure RFC 8693 token exchange so the exchanged token includes `act.sub`, plus the audience and scope you want the delegation rules to see.
4. Give the worker application the Authorize roles for attributes, services, policies, versions, and decision endpoints.
5. Run Scaffold once from the Policy tab.
6. In the PingOne console, paste the resource client id into `introspect-client-id` and the resource client secret into `introspect-client-secret`. Do not put that secret in `enterprise.json` or the git repo.
7. Optional: set `authorize.delegations` to the humans and agents that may be paired. Leave it empty to rely on the active-delegation rule.
8. Leave `isApproved` out of every rule until the human-in-the-loop flow in issue #20 is configured. A missing attribute throws and becomes a deny.
9. Trial licenses share a low configuration rate limit. Scaffold paces management writes and retries `429 REQUEST_LIMITED`. It does not retry `QUOTA_EXCEEDED`.

Reset local policy cache clears this computer's policy rows and saved Trust Framework ids. It does not delete the PingOne objects and it does not recreate them. Confirm Scaffold again to relink by name.
