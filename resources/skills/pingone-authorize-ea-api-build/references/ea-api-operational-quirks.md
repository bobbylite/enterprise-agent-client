# EA API Operational Quirks

Miscellaneous but important operational facts about PingOne Authorize's Early Access Admin API, confirmed through live use.

## Rate limiting is silent

The EA API has a rate limiter that returns `REQUEST_LIMITED` and silently drops requests under load. **Build a sleep between POSTs** when creating multiple resources (e.g. several Trust Framework attributes) in a loop. Don't assume a missing resource after a batch-creation loop means your logic was wrong — check whether some requests were rate-limited first.

## Worker app authentication requires Basic auth, not body credentials

```bash
curl -u '<client_id>:<client_secret>' \
  -d 'grant_type=client_credentials' \
  https://auth.pingone.com/<env-id>/as/token
```

Passing `client_id`/`client_secret` in the request body instead returns `"Unsupported authentication method"`.

## Deploy mechanics differ by resource type

- **Free-standing policies bound to a Decision Endpoint you fully control:** `POST /apiServers/{id}/deployment` (or the equivalent for the resource type) works directly with a Worker app Bearer token.
- **AAM API Servers:** `POST /environments/{envId}/apiServers/{id}/deployment` with a Worker app Bearer token **works** — returns HTTP 200 and a new `authorizationVersionId`. Previously believed to require a gateway `client-token`; empirically disproven 2026-08-16 (an independent live test: `POST .../apiServers/<api-server-id>/deployment` with Worker Bearer token → HTTP 200, `authorizationVersionId: <authorization-version-id>`). The console deploy button remains a valid fallback but is not required.
- **Either way, always confirm deploy actually took effect** via `GET /environments/{envId}/apiServers/{apiServerId}/deployment` and checking that `authorizationVersionId` changed. A PUT to the policy object succeeding does not mean the change is live — the Decision Endpoint keeps serving the previously-deployed version until deploy happens, and a deploy call can be a no-op if the policy hash matches what's already deployed.

## API Service creation via API is environment-sensitive

`POST` for creating an API Service directly has returned opaque `400` responses in some environments and older attempts; prefer console creation when the API rejects the request. **Live-confirmed exception in a private test tenant (2026-08-31):** API creation succeeded with HTTP 201 when the request used a newly created, dedicated custom OAuth resource rather than a resource already linked to another API Service. Reusing an OAuth resource already linked to another API Service correctly failed with a constraint because one resource can only be linked to one API Service. The successful body included `name`, `description`, `baseUrls: ["http://kong:8000"]`, `authorizationServer: {resource: {id: "<dedicated-resource-id>"}, type: "PINGONE_SSO"}`, and `accessControl.custom.enabled: true`. Always GET the result, confirm the Base URL and resource association, and do not assume API creation is portable across tenants.

## Admin collections this skill has and has not exercised

Exercised and working with a Worker Bearer token (list and single-resource GET): `authorizationAttributes`, `authorizationPolicies`, `authorizationVersions` (incl. `/tag`), `decisionEndpoints`, `apiServers` (incl. `/deployment`), `authorizationServices`, `connectorTemplates`.

**Not exercised:** `authorizationConditions` and `authorizationProcessors`. Every condition in this skill is authored **inline** on a rule — a `condition` object inside a `children` entry — never as a standalone named resource, so the `authorizationConditions` collection has never been called here. A `403 "You do not have access to this resource"` against it has been reported in at least one tenant; the cause is unestablished, and that message is PingOne's generic `ACCESS_FAILED` string, which carries no diagnostic content (the same text appears on every policy DENY). Candidate causes are a Worker-app role/scope gap or the collection not being enabled for that environment's EA generation — distinguishing them needs the full response body with `id`/`code` plus the caller's role assignments. Do not record it as broken, and do not treat its unavailability as a blocker: nothing in this skill's workflow depends on it.

Note also that a working GET on any of these collections says nothing about POST/PUT on the same collection. Read-plane success is not write-plane evidence — `authorizationServices` is the standing example, where `POST` has returned opaque `400`s in environments whose `GET` worked fine.

## The flat policy list endpoint ignores `parent` as a filter

Listing policies doesn't reliably filter by parent — individual `GET`s by ID are the authoritative source for tree structure and placement, not a list-with-filter call.

## The `parent` field on POST is ignored for AAM-managed placement

Already covered in `policy-and-rule-authoring.md` in full, repeated here for visibility: `POST /authorizationPolicies` with `parent: {id: <managed-custom-node-id>}` does not place the policy where you asked — it lands in the flat `Policies` library instead, or errors, depending on exact conditions. It can also return `201` while misplacing the policy, so a success status is not evidence.

Do not route around this with a different POST. Follow the placement decision tree in `policy-and-rule-authoring.md`: GET the Custom node, and if it reports `disallowChildren: false`, use the full-parent PUT canary against that node; only if `disallowChildren` is true or the PUT is rejected does this require the one-time console shell step. The console step is a fallback, not the only path.

## Rules are not individually addressable

Repeated here for visibility since it trips people up in multiple contexts: `GET /authorizationPolicies/{rule-id}` returns `NOT_FOUND` even for a rule UUID you just saw. Rules only exist embedded in a parent policy's `children` array. Any change to a rule requires a full PUT of the parent with the updated array.

## Direct Decision Endpoint lifecycle is separate from AAM deployment

For non-AAM, application-side decisions, use the documented direct Decision Endpoint routes:

- Create endpoint: `POST /v1/environments/{envId}/decisionEndpoints`
- Evaluate endpoint: `POST /v1/environments/{envId}/decisionEndpoints/{decisionEndpointId}`
- Read direct history: `GET /v1/environments/{envId}/decisionEndpoints/{decisionEndpointId}/recentDecisions`

The evaluation body requires a `parameters` object and accepts optional `userContext`; do not substitute the unverified `subject/resource/action/context` shape.

Non-AAM policies are created through `POST /v1/environments/{envId}/authorizationPolicies`. A configuration version must be tagged before attachment:

```text
PUT /v1/environments/{envId}/authorizationVersions/{versionId}/tag
```

Then attach it to the endpoint with `authorizationVersion.id`, GET the endpoint, and perform a live evaluation. A `policyId` update can return HTTP 200 without persisting, so a successful update is never sufficient evidence.

A direct decision response can be HTTP 200 with `status.code: OKAY` and `decision: DENY`, without a denial reason. A child unconditional permit can still result in DENY when the endpoint evaluates the effective shared/root policy tree and its combining behavior; confirm the attached version and effective root before diagnosing the policy as inactive. In particular, unconditional permit and deny siblings under `DENY_OVERRIDES` always produce DENY. Test PERMIT and DENY as sequential policy states, not as coexisting unconditional siblings.

Public documentation reviewed does not specify a deployment-package refresh operation, cache TTL, propagation delay, invalidation trigger, or read-after-write consistency guarantee after policy edit, tagging, or endpoint attachment. It documents fixed-version and always-current selection modes, not immediate runtime convergence. Treat unexpected package or trace behavior as an explicit documentation gap until verified by a documented operation or Ping Identity support.

Statement interpolation requires a Trust Framework attribute UUID in the literal payload string, not a human-readable parameter name. A bare token such as `{{judge_risk_score}}` is rejected with `Expected an attribute ID`; static JSON payloads without interpolation work.

## Direct REQUEST resolver and always-current test limits

For direct Decision Endpoint conditions, the confirmed processor-free `REQUEST` recipe requires a literal parameter key equal to the attribute's full name and a JSON value matching `valueType`. Friendly keys and leftover JSONPath processors cause unresolved/indeterminate or type-conversion failures. Always-current endpoints are useful for this development loop, but their own `429 REQUEST_LIMITED` response says they are intended for policy development/debugging only and high-volume traffic is rejected; space evaluations and use fixed-version mode for production load.

For SERVICE-based RFC 7662 introspection, an empty REQUEST token is not a valid negative control: it resolves as an empty string, the service sends `token=`, PingOne returns `400 No value supplied for required parameter: token`, and the policy becomes `INDETERMINATE`. Use a real nonempty token to test the service path; use a nonmatching valid token for the PERMIT control.

## AAM API Service deployment creates/updates the owned Decision Endpoint

For a newly created AAM API Service, the API Server GET may initially omit a `decisionEndpoint` object. The first successful `POST /apiServers/{apiServerId}/deployment` can create or expose the owned Decision Endpoint and return both its ID and the deployed `authorizationVersion.id`. In a live second-checkpoint build (a Kong-fronted API Service sitting behind an earlier PingGateway enforcement point), deployment returned `DEPLOYMENT_SUCCESSFUL` with decision endpoint `<decision-endpoint-id>` and authorization version `<authorization-version-id>`; a subsequent deployment GET confirmed both. Treat the deployment GET, not the policy version, as authoritative.

## AAM recent-decision recording may be immutable/unsupported on owned endpoints

A newly created AAM-owned Decision Endpoint may read back `recordRecentRequests: false`. A PUT attempting to set only `recordRecentRequests: true` can fail validation (`name must not be empty`), while a full-body PUT may return an accepted response without changing the field. Do not assume the direct `recentDecisions` API will capture AAM sideband calls; the known platform limitation remains: use the PingOne Authorize Recent Decisions / Decision Visualizer console path for AAM evaluation traces.

## `recentDecisions` does NOT capture AAM sideband decisions

`GET /environments/{envId}/decisionEndpoints/{deId}/recentDecisions` always returns 0 results for decisions made via the AAM sideband path (`http-access-api.pingone.com`), even when `recordRecentRequests: true` is set on the Decision Endpoint. This is a documented platform limitation:

> **"The Record recent decisions option isn't supported for decisions made by Authorize gateway instances."** — developer.pingidentity.com/pingone/authorization_using_pingone_authorize/p1az_recent_decisions.html

`recentDecisions` only captures decisions that hit the DE's direct evaluation path. AAM sideband calls are routed through the gateway/AAM internal path, which is architecturally separate and never writes to the buffer.

**For AAM decision traces, use the Decision Visualizer in the PingOne console** (Authorization → Recent Decisions). The visualizer accepts pasted gateway decision log JSON and renders the full decision tree, attributes, and services. This is the only way to get rule-level trace evidence from AAM sideband calls — there is no API equivalent.

**Practical implication:** do not attempt to automate post-sideband trace retrieval via `recentDecisions` for AAM-backed operations. The console Decision Visualizer is the sole debugging path for this class of decisions.
