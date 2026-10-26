---
name: pingone-authorize-ea-api-build
description: Build, wire, and debug PingOne Authorize policies, Trust Framework attributes, resolvers, statements, and API Access Management (AAM) rules against PingOne's Early Access (EA) Admin API — not the snapshot-file/import workflow. Use this whenever the user is calling PingOne Authorize's Management API directly (authorizationAttributes, authorizationPolicies, apiServers, decisionEndpoints, sideband/request), debugging a sideband decision, writing a Trust Framework attribute resolver (Path Parameters, Query Parameters, Headers, PingOne User, HTTP Service), authoring a modify-query or other obligation statement, hitting a confusing PUT/POST error against authorizationPolicies, seeing an unexpected DENY or 500/403 from a decision endpoint, or working with PingGateway's PingAuthorizeFilter or Kong's kong-plugin-ping-auth sideband integration. Push hard to consult this before writing any live API call against PingOne Authorize's EA endpoints — this API has many non-obvious, undocumented behaviors that are expensive to rediscover and are all captured here.
---

# PingOne Authorize — EA Admin API Build & Debug

**Last verified: 2026-08-31.** Every claim in this skill and its references is a live observation against a specific tenant and EA API generation, not a platform guarantee. Individual findings carry their own date where one is known; an undated claim predates 2026-08-31 and has not been re-confirmed since. Re-verify anything load-bearing before relying on it in a customer-facing build.

This skill is for **live, incremental authoring against PingOne Authorize's Early Access Admin API** — creating attributes, writing policies and rules, wiring statements, deploying, and verifying via real sideband calls. It is NOT the snapshot-generation workflow (author-offline, generate a JSON file, import once) — if the user wants that instead, look for a snapshot/import-oriented skill.

This skill exists because the EA API has a long list of behaviors that are either undocumented, tenant/version-sensitive, or documented misleadingly, and getting them wrong produces **silent wrong results**, not helpful errors, most of the time. Treat every live observation as scoped to the target tenant and API generation until independently reproduced. Follow the verification discipline in this file religiously — it's not optional ceremony, it's the difference between real evidence and a false result that looks identical to a correct one.

## The core mental model

AAM-managed policy trees and direct Decision Endpoint policy resources have different authoring boundaries. For AAM, the policy tree splits into two zones:

1. **System-owned / managed nodes** — the `API Access Management` tree, and specifically the `Custom` node under each Operation's `Inbound Request`/`Outbound Response`. These commonly have `managedEntity.restrictions.readOnly: true`, but that flag does not by itself mean the child collection cannot be updated. **The POST placement route remains unreliable:** `POST .../authorizationPolicies` with `parent: {id: <custom-node-id>}` can return `201` while silently placing the new policy under the flat shared `Policies` root. Do not use POST-with-parent for AAM placement.

   **Live-confirmed AAM placement route (a private test tenant, 2026-08-31):** when a target Custom node GET returns `managedEntity.restrictions.disallowChildren: false`, a full `PUT` directly to the managed Custom node can create the child policy without a console-created skeleton. Preserve the Custom node's current `id`, `version`, `name`, `enabled`, and `combiningAlgorithm`, and replace its `children` array with a new `type: POLICY` child. The API returned `200`; a subsequent GET showed the child under the Custom node, the child's parent link pointed to that Custom node, and the child had no `managedEntity` (therefore it was writable). This is live-confirmed behavior, not yet a universal platform guarantee. If `disallowChildren` is true, the PUT is rejected or cannot place children; use the console shell workflow. Always GET the Custom node first and verify placement after the PUT.
2. **Your own policies, once they exist** — anything you (or a human, via console) create *inside* a Custom node, or anywhere in the free-standing `Policies` library. These are **fully writable via API** — including adding/editing rules, conditions, and statements. On read-back they either omit the `managedEntity` block entirely or carry `managedEntity: false`; both indicate a writable node, so test for "not managed" rather than for a literal `false` (a check like `managedEntity === false` fails on the absent-key form).

For **AAM-managed Custom nodes**, use this decision tree: GET the Custom node first; if `disallowChildren: false`, prefer the verified full-parent PUT child-creation route and retain the console shell as a fallback; if `disallowChildren: true` or the PUT is rejected, have a human create one empty shell policy in the console, then use API PUTs for rules and statements. For AAM challenge/step-up behavior, use the AAM Operation `auth-challenge` action/configuration exposed by the AAM editor/API; do not copy the direct-PDP `modify-query` recipe. This console step is not required for free-standing non-AAM policies or direct Decision Endpoints. See `references/policy-and-rule-authoring.md` for the exact AAM placement workflow, `references/statements-and-obligations.md` for the policy-model statement boundary, and `references/decision-endpoints.md` for the direct workflow.

For a direct non-AAM policy, the reviewed public API documentation does not define an independent root/Policy Set creation route or an alternate `type` such as `POLICY_SET` or `ROOT`; do not guess at either. **Sandbox-specific observation:** policies created through `POST /authorizationPolicies` in a private test tenant became children of the existing shared `Policies` root. Do not generalize that observed placement as a universal platform fact. In a shared environment, isolation comes from careful policy authoring (especially avoiding self-conflicting sibling rules) or from a dedicated environment, not from an undocumented alternate root.

## Non-negotiable verification discipline

Repeated live testing has exposed results that *looked* correct but weren't — a fabricated UUID silently producing a stale test result for two full sessions; a `payload` string left pointing at the wrong attribute while the `attributes` array looked right; a deploy that never actually landed because the wrong field was checked for confirmation. Follow this every time, no exceptions:

- **Before wiring any attribute UUID into anything:** `GET` it directly, print the full response, confirm the `id` matches exactly. Never trust a UUID from memory, a truncated 8-char prefix, or a variable name.
- **Never suppress state-changing API errors**, but redact sensitive values before displaying or saving output. Print HTTP status, error bodies, resource IDs, and non-secret response structure. Never print bearer tokens, client secrets, gateway credentials, refresh tokens, raw `Authorization` headers, or unredacted introspection/gateway debug payloads.
- **After every PUT, re-GET the resource** and confirm the written fields — especially the `payload` string inside statements, not just the `attributes` array — actually changed to what you intended. See "the payload string vs. attributes array trap" below.
- **Deploy confirmation uses `authorizationVersionId`** from `GET /environments/{envId}/apiServers/{apiServerId}/deployment` — **not** the policy object's own `version` field, which reflects configuration state, not deployed-engine state. Confirm this value actually changed, immediately before treating any sideband test as evidence.
- **When a hypothesis seems confirmed by one clean result, test a second, structurally different case before trusting it.** Several false conclusions in the reference implementation's history came from one round of testing that later turned out to be invalid (stale deploy, wrong UUID) — a second independent confirmation is cheap insurance.
- **Read-before-trust:** in a multi-step session, re-GET the current resource before drawing a conclusion. Do not reuse an earlier read, an earlier tagged version, or an unverified claim or screenshot as this run's evidence. A `200` from a PUT is never sufficient proof; only a subsequent GET showing the expected state counts.

## Portability and sharing boundary

This skill is intended to be shareable, but it is an operational guide, not a guarantee that every EA tenant exposes identical behavior. Replace all placeholders before use: `<environment-id>`, `<api-server-id>`, `<operation-id>`, `<custom-node-id>`, `<authorization-attribute-id>`, `<oauth-resource-id>`, and `<decision-endpoint-id>`. Do not copy IDs, names, client IDs, URLs, credentials, or policy assumptions from another tenant.

Required prerequisites are: an active PingOne environment; access to the PingOne Authorize EA Admin API; a worker or equivalent OAuth client with the required management permissions; permission to create/read/update API Services, Operations, Trust Framework attributes, policies, and deployments; and, if the direct Custom-node PUT canary is unavailable, console access to create the one-time policy skeleton. A valid caller token is also required for runtime testing, and its audience/scope must match the API Service resource being tested.

The examples and live evidence in this skill came from multiple private test environments. They are evidence for troubleshooting, not portable tenant configuration. Keep tenant-specific IDs and transcripts in a separate private appendix; do not add them to a shared copy of this skill. Never publish bearer tokens, client secrets, gateway credentials, refresh tokens, raw introspection responses, or unredacted gateway debug logs.

## Policy-model boundary: AAM versus direct Decision Endpoint

Do not transfer statement/action advice between these two policy models without a live test:

- **Direct Decision Endpoint / PDP policies** (for example, an application sidecar) use the direct statement model documented in `references/statements-and-obligations.md`; the live-tested `modify-query` pattern belongs here.
- **AAM API Service / Operation policies** (for example, PingGateway or Kong sideband enforcement) use the AAM Operation action/statement model. For step-up or challenge behavior, use the AAM-supported `auth-challenge` action/configuration exposed by the AAM policy editor/API, as shown in the target tenant's AAM UI/schema. Do not copy a direct-PDP `modify-query` marker into an AAM rule merely because it serialized successfully. A statement can read back correctly yet fail at runtime with an AAM/plugin `UNEXPECTED_ERROR`.

The same statement code can have different support or runtime semantics depending on policy model and applies-to phase. Validate the exact AAM action in an inbound Operation decision before deploying a customer-facing gateway. The Decision Visualizer and gateway/plugin debug logs are the evidence sources for AAM action execution; direct `recentDecisions` is not.

## AAM Custom-node PUT canary: operational procedure

Use the direct child-creation route only as a controlled canary in a tenant where the target Custom node GET reports `disallowChildren: false`.

1. GET the Custom node immediately before the PUT.
2. Save its complete current `children` array and `version`.
3. Add one clearly temporary child policy to the array; do not delete or overwrite existing children.
4. PUT the complete parent representation with the fresh `id` and `version`.
5. GET the parent and child; confirm the child parent link and writable state.
6. If placement is wrong, stop, delete only the canary child after confirming its location, and use the console fallback.
7. Do not use this canary in production without a tested rollback plan.

## The payload string vs. attributes array trap

In a `modify-query` (or other) statement, the `attributes` array is only a dependency declaration — it does **not** control what value gets injected. The actual reference is the `{{attribute-uuid}}` token embedded in the `payload` string. **Leave `attributes: []` empty; the payload string's `{{uuid}}` is the only thing that's load-bearing.** If you swap which attribute you're testing by editing the `attributes` array but forget the `payload` string, every test will keep silently resolving the old attribute — this exact bug cost two full debugging sessions on the reference implementation. Always re-GET and read the literal `payload` string after any change, not just the array.

## Direct Decision Endpoint quick reference

Use this path for a non-AAM, application-side authorization decision. Official Decision Evaluation documentation calls it the integration point for custom applications. It is distinct from AAM gateway sideband enforcement, which is another documented architecture rather than a prerequisite for the direct call.

### Full create → author → tag → attach → evaluate recipe

1. Create the policy:

   ```http
   POST /v1/environments/{envId}/authorizationPolicies
   ```

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

2. Author rules by `PUT`ting the full policy with the modified `children` array. Re-GET first and preserve the policy `id` and `version`; existing rules also require their own `id` and `version`.
3. Find the authorization version generated by the policy change and tag it:

   ```http
   PUT /v1/environments/{envId}/authorizationVersions/{versionId}/tag
   ```

   A policy configuration version is **not attachable until tagged**. Attaching an untagged version fails with 404 and an `is not tagged` message.
4. Create the Decision Endpoint:

   ```http
   POST /v1/environments/{envId}/decisionEndpoints
   ```

   ```json
   {"name": "example-endpoint", "description": "Example", "recordRecentRequests": true}
   ```

5. Attach the tagged version by `PUT`ting the endpoint with `authorizationVersion: {"id": "<tagged-version-id>"}`. The endpoint's `policyId` field may accept a write but does not reliably persist or affect evaluation; always use `authorizationVersion.id`. A successful PUT is not proof: immediately GET the endpoint and confirm the attachment.
6. Evaluate:

   ```http
   POST /v1/environments/{envId}/decisionEndpoints/{decisionEndpointId}
   ```

   ```json
   {
     "parameters": {
       "Example.judge-risk-score": 42,
       "Example.refund-count-30d": 1
     },
     "userContext": {"user": {"id": "<uuid>"}}
   }
   ```

   **Every `parameters` key must literally equal the target attribute's full Trust Framework name**, including its parent path (`Example.` here stands for whatever non-AAM parent you created the attribute under). A friendly key such as `judge_risk_score` does not resolve — it produces `MISSING_ATTRIBUTE` and the response becomes `INDETERMINATE`. See "The confirmed direct `parameters` → condition recipe" below.

   This endpoint contract is **not** the `subject/resource/action/context` envelope used by the older standalone authorizationPolicies test endpoint. They are separate, incompatible request shapes. Confirm the response's `authorizationVersion.id` matches the endpoint GET.

Direct responses may be HTTP 200 with `status.code: OKAY` and `decision: DENY` without a denial reason. Direct calls can appear in `recentDecisions` when enabled; AAM gateway sideband calls do not. Statement interpolation uses a Trust Framework attribute UUID, not a human-readable parameter name. A child unconditional permit can still produce DENY when the endpoint evaluates the effective shared/root policy tree; child-policy evaluation is not proof of effective-root behavior.

See `references/decision-endpoints.md` for the full lifecycle and verification checklist.

## The confirmed direct `parameters` → condition recipe

This is the most important direct-endpoint finding from the reference implementation investigation. It is **not documented** in the public API material; it is live-confirmed behavior:

1. Create the attribute under a normal, non-AAM Trust Framework parent (for example, `Example`). Do not put direct-call attributes under the managed API Access Management tree. That placement was not conclusively proven to be the blocker, but the working recipe was confirmed under a normal parent and should be the default.
2. Use a processor-free `REQUEST` attribute:

   ```json
   {
     "name": "risk-score",
     "type": "ATTRIBUTE",
     "parent": {"id": "<normal-parent-id>"},
     "resolvers": [{"type": "REQUEST"}],
     "valueType": {"type": "NUMBER"}
   }
   ```

   **Do not add a `processor`.** A JSONPath/type-conversion processor runs after the request resolver has already returned the scalar and tries to parse that scalar as nested JSON, causing `TYPE_CONVERSION_ERROR`.
3. The request parameter key must be the attribute's own full name, not a descriptive field name:

   ```json
   {
     "parameters": {
       "Example.risk-score": 90
     },
     "userContext": {"user": {"id": "<uuid>"}}
   }
   ```

   The resolver performs a literal key lookup against the full attribute name. A mismatched key produces `MISSING_ATTRIBUTE` and the plain response becomes `INDETERMINATE`.
4. Send the value using the JSON type declared by `valueType`. A quoted string for a `NUMBER` attribute causes `TYPE_CONVERSION_ERROR`.
5. Reference the attribute UUID normally in a `COMPARISON` condition. Live confirmation with `GREATER_THAN 50` returned `DENY` at numeric `90` and `PERMIT` at numeric `10` using the same policy and always-current endpoint.

This recipe is confirmed for the direct Decision Endpoint path, but remains an undocumented platform behavior. See `references/decision-endpoints.md` and `references/resolvers-and-attributes.md` for the detailed runbook.

## Decision Endpoint version modes and operational limit

There are two modes:

- **Fixed-version:** supply `authorizationVersion.id`. The policy configuration is fetched and stored locally for the endpoint. Policy edits do not become active until the appropriate version is tagged and reattached. A freshly edited version may hit EA API tag/handler defects; verify the tag operation rather than assuming it worked.
- **Always-current:** omit `authorizationVersion.id`, including when updating an endpoint that previously had one. The endpoint evaluates the latest policy on each request; no tag/attach step is needed. This was confirmed end-to-end and is useful for development/debugging.

Always-current mode is not a production-throughput mode. The platform's own `429 REQUEST_LIMITED` response says it is “intended for policy development and debugging only,” and that high-volume traffic will be rejected. Space evaluations during tests. For production load, use the documented fixed-version path after verifying tag/attach behavior.

## Shared-root and DENY_OVERRIDES gotchas

Every direct non-AAM policy created through this EA API is nested under the one environment-wide `Policies` root. Under `DENY_OVERRIDES`, an unconditional permit rule and an unconditional deny rule as sibling children produce a permanent `DENY`; the deny wins by design, with no rule ID or explanation in the direct response. This can look like an attachment or evaluation failure even when the tagged version is attached correctly.

When testing PERMIT and DENY behavior on the same policy, use **sequential states**: edit the policy, tag the resulting version, attach it, evaluate and capture the result; then edit the policy again and repeat. Do not leave unconditional permit and deny rules coexisting as siblings under the shared root. Isolation requires careful policy authoring or a dedicated environment; there is no independent root creation path documented for this API.

A child permit can also become `INDETERMINATE` when an unrelated shared-root sibling references an unresolved attribute; this is distinct from the deterministic permit/deny sibling conflict. Inspect the effective root before assigning blame to endpoint attachment.

## Statement interpolation gotcha

A statement token must contain a verified Trust Framework attribute UUID. A bare parameter name such as `{{judge_risk_score}}` is rejected with HTTP 400 (`Expected an attribute ID`). Static JSON statement payloads without interpolation are valid and save/read back normally. Re-GET the saved statement and inspect the literal `payload` string; the `attributes` array does not substitute for the UUID.

## `act.sub` and nested actor chains

For PingOne token/resource attribute mapping, the official one-hop expressions are:

```spel
#root.context.requestData.subjectToken.sub
```

for the downstream resource's `sub`, and:

```spel
(#root.context.requestData.subjectToken.may_act.sub == #root.context.requestData.actorToken.client_id)?#root.context.requestData.subjectToken.may_act:null
```

for its `act`, copying the user's `may_act` only when it matches the presented actor client. The agent resource's `may_act` expression is:

```spel
(#root.context.requestData.grantType == "client_credentials")?null:({ "sub": #root.context.appConfig.clientId })
```

These are token-exchange resource mappings, not direct Decision Endpoint condition expressions. For arbitrary multi-hop chains, the reference implementation's separate token-exchange investigation confirmed a manual append-not-overwrite map must be authored on every hop (wrap the current actor and preserve the incoming `act`), rather than relying on an automatic built-in nesting behavior. No direct Decision Endpoint resolver binds `parameters` to nested `act.act.sub`; for real JWT actor claims, use the documented AAM/Gateway context path such as `${contexts.oauth2.accessToken.info.act.sub}` / `idmQueryValue` with an actor identity resource. For a platform-verified actor claim without relying on an app's own JWT decode, use the SERVICE/RFC 7662 introspection recipe in `references/resolvers-and-attributes.md`.

## Quick-reference: what's confirmed working vs. broken

| You want to... | Use | Reference |
|---|---|---|
| Extract a value from a path segment (`/vendors/{id}`) | Path Parameters system attribute, plain JSONPath (`$.vendorId`), no index needed | `resolvers-and-attributes.md` |
| Extract a value from a query string (`?vendorId=6`) | Query Parameters system attribute, JSONPath **with `[0]` index** (`$.vendorId[0]`) | `resolvers-and-attributes.md` |
| Extract a value from a request header | Request Headers system attribute, JSONPath **with `[0]` index** (`$['x-header-name'][0]`) | `resolvers-and-attributes.md` |
| Read a PingOne user's custom attribute | PingOne User resolver, direct — no HTTP Service workaround needed | `resolvers-and-attributes.md` |
| Inject a value into the outbound request on PERMIT — **direct PDP only** | `modify-query` statement — confirmed working in the direct Decision Endpoint/PDP model. Do **not** copy into an AAM Operation rule; it can save and deploy cleanly yet return `500 UNEXPECTED_ERROR` at runtime | `statements-and-obligations.md` |
| ~~Inject via `set-header`, `url-rewrite`, `custom-attributes`, `add-query-parameters`~~ — **direct PDP, `appliesTo: PERMIT` only** | **Confirmed NOT working in that specific context** — don't retest them there. Untested on other `appliesTo` values and in the AAM model | `statements-and-obligations.md` |
| Challenge / step-up in an **AAM** Operation policy | The AAM-supported `auth-challenge` action/configuration exposed by the AAM editor/API. The old blanket "`auth-challenge` doesn't work" result was scoped to direct-PDP PERMIT experiments and does **not** carry over to AAM — do not skip it on that basis | `statements-and-obligations.md` |
| Guard a condition against a possibly-missing attribute | **No `IS_PRESENT`/`EXISTS`/`NOT_NULL` exists.** A missing attribute throws, not evaluates false. See below. | `condition-evaluation-and-nulls.md` |
| Author a **named, reusable condition** via `authorizationConditions` | **Untested.** Every condition in this skill is authored inline on a rule (`condition` object inside a `children` entry). The `authorizationConditions` collection has never been exercised here, and a `403` against it has been reported in at least one tenant — cause unestablished (role/scope gap vs. collection not enabled). Treat as unknown, not as broken | — |

## The single most important gotcha: missing attributes DENY, they don't evaluate false

If a rule's condition references an attribute (e.g. `department EQUALS "raw_materials"`) and that attribute **doesn't exist** on the evaluated user/request (as opposed to existing with an empty value), PingOne does **not** evaluate the comparison as `false`. It throws `PROCESSING_ERROR` at the JSONPath resolution layer, which propagates as an **indeterminate** result. Under `FIRST_APPLICABLE` combining, an indeterminate result **halts the chain** — it does not fall through to the next rule. The parent's `DENY_OVERRIDES` algorithm then converts indeterminate to a hard `DENY`.

**This means:** every user/entity evaluated by a policy must have a non-null value for **every** attribute any rule in that policy's chain references — even attributes structurally irrelevant to that entity's role — or they'll get an unexpected DENY. There is no policy-level guard against this (no presence comparator exists). The only two confirmed mitigations are (a) provisioning discipline — give every entity a placeholder value for attributes that don't apply to them — or (b) restructure with `OR` (a resolving branch can rescue an indeterminate via permit-override semantics, but this merges match paths into one rule, which may not fit your design). Full detail, including everything ruled out, in `condition-evaluation-and-nulls.md` — **read this before writing any conditional rule.**

## Choosing REQUEST-flattening versus SERVICE-based token introspection

These are complementary recipes, selected per attribute rather than per policy:

- **REQUEST-flattening** is for app-computed values with no independent verification concept, such as a risk score or model confidence. The app must supply that value; there is no issuer to verify it.
- **SERVICE-based introspection** is for genuine token claims, especially delegated actor identity. Authorize independently verifies the token with RFC 7662 instead of trusting an app's own JWT decode or self-reported actor field. A single policy can use both approaches for different attributes.

### Platform-verified actor identity via token introspection

This recipe is live-confirmed with a real condition split: a matching actor claim produced `DENY`, and a nonmatching actor claim produced `PERMIT`.

1. Create two constant (or equivalent) Trust Framework attribute Definitions containing the OAuth resource client ID and secret. Reference those Definition IDs from the SERVICE Basic-auth fields; do not use the raw OAuth resource ID. Using the resource ID directly causes `No element with id 'Definition{<resource-id>}'`.
2. Create the HTTP SERVICE **top-level in the Services hierarchy** with no `parent`. Services and attributes are separate trees. A service created under an attribute parent may return `201` but be absent from the Services tab and produce `Definition is not ServiceDefinition. It is AttributeDefinition.` or a generic `404 NOT_FOUND` at evaluation.
3. Use `authentication.type: BASIC` for RFC 7662. Do not use `CLIENT_CREDENTIALS`; that unnecessary token-acquisition step produced `invalid_client` from `/as/token`.
4. Configure the service body with the token attribute UUID, not its name:

   ```json
   {
     "serviceType": "HTTP",
     "serviceSettings": {
       "type": "HTTP",
       "url": "https://auth.pingone.com/<envId>/as/introspect",
       "verb": "POST",
       "contentType": "application/x-www-form-urlencoded",
       "body": "token={{<token-attribute-uuid>}}",
       "authentication": {
         "type": "BASIC",
         "name": {"id": "<client-id-definition-id>"},
         "password": {"id": "<secret-definition-id>"}
       },
       "tlsSettings": {"tlsValidationType": "DEFAULT"},
       "timeoutMilliseconds": 3000
     },
     "valueType": {"type": "JSON"}
   }
   ```

5. Supply the raw token through a processor-free `REQUEST` attribute, keyed by its full name in `parameters`, and ensure it is nonempty:

   ```json
   {"parameters": {"Example.myToken": "<access-token>"}}
   ```

   An empty string resolves as a valid `STRING`, but the introspection endpoint returns `400 No value supplied for required parameter: token`; the policy result becomes `INDETERMINATE`, not `PERMIT` or `DENY`.
6. Create a downstream attribute with a `SERVICE` resolver and JSONPath processor:

   ```json
   {
     "resolvers": [{"type": "SERVICE", "value": {"id": "<service-id>"}}],
     "processor": {"type": "JSON_PATH", "expression": "$.act.sub", "valueType": {"type": "STRING"}},
     "valueType": {"type": "STRING"}
   }
   ```

   JSONPath is appropriate because introspection returns a JSON document; it is not appropriate on scalar-returning `REQUEST` or `CURRENT_USER_ID` attributes. The same response can expose deeper claims such as `$.act.act.sub`.

Official sources:

- [Token Introspection (Resource ID and Secret)](https://developer.pingidentity.com/pingone-api/auth/openid-connect-oauth-2/token/token-introspection-resource-id-and-secret.html)
- [Create Authorization Service](https://developer.pingidentity.com/pingone-api-ea/authorize/early-access/pingone-authorize-admin-apis/pingauthorize-trust-framework/authorization-services/create-authorization-service.html)
- [Authorization Attributes](https://developer.pingidentity.com/pingone-api-ea/authorize/early-access/pingone-authorize-admin-apis/pingauthorize-trust-framework/authorization-attributes.html)

## Workflow

1. **Build/confirm Trust Framework attributes first**, fully via API (`POST /environments/{envId}/authorizationAttributes`), verified individually via direct sideband/decision-endpoint calls before wiring them into any rule. For direct Decision Endpoint `parameters`, create them beneath a normal non-AAM parent rather than the managed API Access Management tree. See `resolvers-and-attributes.md` for resolver types, the array-indexing gotcha, and the direct `REQUEST` recipe.
2. **If targeting an AAM Custom node**: GET the Custom node first. If `disallowChildren: false`, use the verified full-parent PUT canary to create a child policy; otherwise, or if PUT is rejected, have a human create the empty shell policy in console. If targeting the free-standing `Policies` library: skip straight to API.
3. **Author rules via API** against the writable child policy, or create/update a free-standing non-AAM policy directly — full PUT of the parent with an updated `children` array (rules are not individually addressable; see `policy-and-rule-authoring.md`). For AAM challenge/step-up behavior use the AAM Operation `auth-challenge` action/configuration; do not copy direct-PDP `modify-query` guidance into an AAM rule.
4. **Publish the correct resource type.** For a direct Decision Endpoint, tag the policy authorization version, attach it with `authorizationVersion.id`, GET the endpoint, and verify the version ID in a live decision. For AAM API Servers, use the AAM deployment route described in `ea-api-operational-quirks.md`.
5. **Confirm the active version through the relevant GET and live response**, not only through a successful PUT or policy configuration version. Public documentation does not guarantee package refresh, cache invalidation, or immediate runtime convergence after edit/tag/attachment.
6. **Treat verbose package/tree/log fields as undocumented trace evidence** unless the target route and response mode are explicitly documented; do not build application behavior around them. The compact direct response and `recentDecisions` do not expose failed-attribute details. Rich fields such as `resolvedBy`, `attributes`, `services`, `decisionTree`, and `evaluationLog` were observed through a richer trace/Decision Visualizer capture, not reproduced as a documented identical direct POST response. Use the Decision Visualizer for unexplained `INDETERMINATE` results when available.
7. **If something looks wrong, don't guess.** Check `references/ea-api-operational-quirks.md` first — most confusing errors here have already been hit and documented. If it's genuinely new, apply the verification discipline above before concluding the platform is broken.
8. **Clean up failed probes.** If a POST-with-parent or other canary creates a policy in the wrong location, confirm the placement, delete the probe, and re-GET the parent/root. Do not leave orphaned or misleading test policies in a shared tenant.

## Gateway-specific notes

The core content above is gateway-agnostic — it's true whether PingGateway, Kong, or a raw `curl` is making the sideband call. A short set of gateway-specific facts (PingGateway's `PingAuthorizeFilter` config surface and a dead-config trap; Kong's `kong-plugin-ping-auth` vs. DIY alternatives) is in `references/gateway-specific.md` — only read this once the core policy/attribute work is solid and you're wiring an actual gateway in front of it.

## Reference files

- `references/resolvers-and-attributes.md` — attribute resolver types, the array-indexing gotcha, PingOne User/HTTP Service resolvers, generated attributes
- `references/policy-and-rule-authoring.md` — the console-shell-then-API workflow in full, exact PUT body shapes, every field that differs from a naive guess, version-field requirements
- `references/statements-and-obligations.md` — which obligation codes work, which don't, the non-scalar-interpolation failure mode
- `references/condition-evaluation-and-nulls.md` — the indeterminate-propagation finding in full, everything tested to guard against it, what actually works
- `references/ea-api-operational-quirks.md` — rate limiting, direct Decision Endpoint lifecycle, deploy mechanics, auth mechanics, and other operational traps
- `references/decision-endpoints.md` — direct non-AAM Decision Endpoint create/evaluate/tag/attach lifecycle and verification
- `references/gateway-specific.md` — PingGateway and Kong integration specifics

Every file listed above ships with this skill. Earlier revisions also pointed at `spikes/spike-01j`, `spike-01q`, `spike-01r`, and `authorize-attribute-rehome-log.md`; those were private working notes and are **not** part of the shared bundle. Their load-bearing conclusions have been folded into `resolvers-and-attributes.md` (introspection/SERVICE recipe, top-level service placement, credential Definition references) and the `act.sub` section above. Do not try to read them.

## Helper script

`scripts/walk_policy_tree.py` — walks a policy tree from a Decision Endpoint's root policy ID and prints every node's id/name/depth. Useful for locating a shell policy's UUID after console creation, or for getting oriented in an unfamiliar tree. See the script's own docstring for usage.
