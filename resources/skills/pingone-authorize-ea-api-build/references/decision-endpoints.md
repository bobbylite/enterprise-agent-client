# Direct Decision Endpoints — non-AAM lifecycle

This reference covers PingOne Authorize Decision Endpoints used for application-side policy decisions. It is separate from AAM gateway sideband enforcement.

## Current documented routes

| Operation | Method and path |
|---|---|
| Create policy | `POST /v1/environments/{envId}/authorizationPolicies` |
| Create endpoint | `POST /v1/environments/{envId}/decisionEndpoints` |
| Read endpoint | `GET /v1/environments/{envId}/decisionEndpoints/{decisionEndpointId}` |
| Update endpoint | `PUT /v1/environments/{envId}/decisionEndpoints/{decisionEndpointId}` |
| Tag policy version | `PUT /v1/environments/{envId}/authorizationVersions/{versionId}/tag` |
| Evaluate endpoint | `POST /v1/environments/{envId}/decisionEndpoints/{decisionEndpointId}` |
| Read direct decision history | `GET /v1/environments/{envId}/decisionEndpoints/{decisionEndpointId}/recentDecisions` |

Use a Worker Bearer token and `Content-Type: application/json` for JSON operations. Pace EA API calls; `REQUEST_LIMITED` can occur on back-to-back requests.

Authoritative documentation:

- [Create Decision Endpoint](https://developer.pingidentity.com/pingone-api/authorize/authorization-decisions/decision-endpoints/create-decision-endpoint.md)
- [Evaluate a Decision Request](https://developer.pingidentity.com/pingone-api/authorize/authorization-decisions/decision-evaluation/execute-a-decision-request.md)
- [Create Authorization Policy](https://developer.pingidentity.com/pingone-api-ea/authorize/early-access/pingone-authorize-admin-apis/pingauthorize-editor-policy-management/authorization-policies/create-authorization-policy.html)
- [Authorize API reference](https://docs.pingidentity.com/pingone/authorization_using_pingone_authorize/p1_az_authorization_api_reference.html)

## Evaluation request shape

For conditions driven by direct runtime parameters, use the confirmed processor-free `REQUEST` attribute recipe in `resolvers-and-attributes.md`: the parameter key must literally equal the attribute's full name and the JSON value must match the attribute's declared `valueType`. A friendly parameter name or a processor that tries to parse the resolved scalar produces an unresolved/indeterminate result.

For platform-verified token claims, use the SERVICE introspection recipe in `resolvers-and-attributes.md`: pass a nonempty raw token through the REQUEST attribute, let a top-level Basic-auth HTTP SERVICE call RFC 7662 `/as/introspect`, and extract the claim with a SERVICE resolver plus JSONPath. Empty token input resolves as a string but makes introspection return `400 No value supplied for required parameter: token`, propagating as `INDETERMINATE`.

The confirmed direct Decision Endpoint request uses a required `parameters` object and optional `userContext`:

```json
{
  "parameters": {
    "Example.judge-risk-score": 42,
    "Example.refund-count-30d": 1
  },
  "userContext": {
    "user": {
      "id": "<uuid>"
    }
  }
}
```

**The `parameters` keys above are full Trust Framework attribute names, not friendly labels.** `Example.` stands for whatever non-AAM parent the attribute was created under; substitute your own. The resolver performs a literal key lookup against the attribute's full name, so a friendly key such as `judge_risk_score` yields `MISSING_ATTRIBUTE` and an `INDETERMINATE` decision — with nothing in the compact response naming the unresolved attribute.

Do not use the earlier unverified `subject` / `resource` / `action` / `context` shape for this API. The direct endpoint accepted the request above and returned a structured decision. Official documentation calls this runtime evaluation endpoint the integration point for custom applications; gateway/sideband evaluation is a separate documented architecture, not a prerequisite for this direct call.

## Create a non-AAM policy

The current EA policy documentation defines:

```http
POST /v1/environments/{envId}/authorizationPolicies
```

Create body:

```json
{
  "type": "POLICY",
  "name": "example-policy",
  "description": "Example",
  "combiningAlgorithm": {
    "algorithm": "DENY_OVERRIDES"
  },
  "enabled": true,
  "children": []
}
```

A free-standing policy can be created directly through this API. This is different from placing a policy inside an AAM-managed Operation → Inbound Request/Outbound Response → Custom node. For AAM placement, follow the target Custom-node GET/`disallowChildren` decision tree in `policy-and-rule-authoring.md`; the direct-PDP lifecycle and statement semantics described in this file do not apply to AAM Operation policies.

**Private-test-tenant observation:** in one sandbox, policies created through this endpoint were observed to become children of the existing shared `Policies` root. The reviewed public documentation does not define an independent root/Policy Set creation type or route. Do not guess at `POLICY_SET`, `ROOT`, or another alternate `type`; an absent public API path is not a universal platform claim.

After creating or updating a policy, GET it back. Record its policy `version` and inspect the authorization-version listing for the version generated by the change. Do not assume the policy configuration version is immediately attachable.

## Tag, attach, and verify

A policy configuration version must be tagged before a Decision Endpoint can attach it.

1. Read the version and its `_links.tag.href`.
2. Tag it using the exact link:

   ```http
   PUT /v1/environments/{envId}/authorizationVersions/{versionId}/tag
   ```

3. GET the tag resource and GET the authorization version. Confirm tag metadata such as `tag.updatedAt`.
4. Attach the tagged version to the endpoint:

   ```http
   PUT /v1/environments/{envId}/decisionEndpoints/{decisionEndpointId}
   ```

   Example body:

   ```json
   {
     "id": "<endpoint-id>",
     "name": "example-endpoint",
     "description": "Example",
     "authorizationVersion": {
       "id": "<tagged-version-id>"
     },
     "recordRecentRequests": true
   }
   ```

5. Immediately GET the endpoint. The response must contain a non-empty `authorizationVersion.id`.
6. Evaluate the endpoint and confirm the decision response also contains that authorization-version ID.

A `policyId` update can return HTTP 200 without persisting. In a private test tenant, the following was accepted but did not appear in the next GET and did not affect evaluation:

```json
{
  "policyId": "<policy-id>"
}
```

Never treat that update as successful without both endpoint read-back and live decision evidence. Prefer the tagged `authorizationVersion.id` attachment sequence.

## Version selection, deployment packages, and consistency

Decision Endpoint documentation describes two modes:

- Supplying `authorizationVersion.id` binds a specific deployed policy version whose configuration is fetched and stored locally.
- Omitting `authorizationVersion.id` makes the endpoint always use the latest policy version available from Policy Editor at runtime.

The reviewed public documentation does **not** state a deployment-package build/refresh lifecycle, cache TTL, propagation delay, invalidation operation, or read-after-write consistency guarantee for policy edit → tag → endpoint attachment → runtime evaluation. Do not claim immediate convergence or stale-cache behavior as a documented platform fact.

The documented authorization-version package GET uses this media type:

```text
Accept: application/vnd.pingidentity.authorizationpolicyversion.deploymentpackage+octet-stream
```

It retrieves executable policy configuration associated with an authorization version. The reviewed docs do not describe a separate build, publish, activate, promote, or refresh operation for that package.

## Response interpretation

A successful HTTP response does not imply a permit. A direct evaluation can return:

```json
{
  "correlationId": "<uuid>",
  "timestamp": "<iso-8601>",
  "elapsedMicroseconds": 1586,
  "status": {
    "code": "OKAY"
  },
  "decision": "DENY",
  "authorizationVersion": {
    "id": "<tagged-version-id>"
  }
}
```

`status.code: OKAY` means the request was processed; `decision: DENY` is still a denial. The tested response did not include an error code, error description, rule ID, policy ID, or denial reason. Treat denial reasons as unavailable unless the specific response contains them. `INDETERMINATE` responses and `recentDecisions` entries are similarly compact and do not identify a failed attribute. Rich trace fields such as `resolvedBy`, `attributes`, `services`, `decisionTree`, and `evaluationLog` were observed through a richer Decision Visualizer capture, not as a documented standard direct POST response.

The create response does not expose a separate callable URL or service token. The callable direct route is derived from the environment ID and Decision Endpoint ID.

Official runtime response documentation covers the compact decision schema. It does not document `deploymentPackageId`, `decisionTree`, `evaluationLog`, `attributes`, or `services` as standard synchronous evaluation fields, nor does it document a `Prefer` header, query parameter, debug flag, trace mode, or media-type switch to request them. Treat such verbose data as trace/internal-format evidence unless the exact route and response control are documented for the target tenant; do not build application behavior around those fields.

## Effective-root and combining behavior

A child policy with an unconditional permit rule is not necessarily equivalent to evaluating that child in isolation. In a private test tenant, the child policy was created under the existing `Policies` root, tagged, and attached successfully. The endpoint evaluated the tagged version but still returned `DENY` because the policy also contained an unconditional deny sibling under the root's `DENY_OVERRIDES` semantics.

An unconditional permit and unconditional deny as sibling rules under `DENY_OVERRIDES` will always produce `DENY`, regardless of anything else being correct. The response does not identify the rule or explain that the deny won. Test permit and deny as sequential policy states rather than coexisting unconditional siblings: edit → tag → attach → evaluate → capture, then edit again and repeat.

Therefore:

- Confirm the effective root policy set and its siblings/combining algorithms.
- Do not infer effective-root behavior from a child policy GET.
- Do not interpret a tagged, attached version plus `DENY` as an attachment failure when the decision response contains the expected authorization-version ID.
- A child permit can also become `INDETERMINATE` when an unrelated shared-root sibling references an unresolved attribute; this is distinct from the deterministic permit/deny sibling conflict.
- Keep AAM-managed/read-only nodes separate from writable policy nodes.

## Recent decisions: direct versus AAM

For a direct Decision Endpoint, `recordRecentRequests: true` causes successful evaluations to appear under:

```http
GET /v1/environments/{envId}/decisionEndpoints/{decisionEndpointId}/recentDecisions
```

The AAM gateway sideband path is different. AAM sideband decisions are not captured by this recent-decision buffer; use the PingOne Authorize Decision Visualizer for AAM traces instead. Do not generalize the AAM limitation to direct endpoint evaluations.

## Statement interpolation

Statement interpolation requires a Trust Framework attribute UUID. A human-readable parameter name is rejected with HTTP 400 (`Expected an attribute ID`):

```text
{{judge_risk_score}}
```

Use a verified UUID in the payload token:

```json
{
  "judge_risk_score": "{{<authorization-attribute-uuid>}}"
}
```

Static JSON statement payloads without interpolation save and read back correctly. As always, the literal `payload` string is load-bearing; the statement `attributes` array does not substitute for the UUID in the payload.

## Verification checklist

- [ ] Use a tenant-safe, clearly temporary prefix for non-AAM policy/endpoint test resources, and record the cleanup plan.
- [ ] Read every created or updated policy and endpoint back.
- [ ] Record the policy configuration version and tag it through `_links.tag.href`.
- [ ] Confirm tag read-back before endpoint attachment.
- [ ] Confirm endpoint `authorizationVersion.id` after attachment.
- [ ] Confirm the same version ID appears in a live decision response.
- [ ] Test at least two structurally different requests; vary one input at a time.
- [ ] Interpret HTTP status, `status.code`, and `decision` independently.
- [ ] Check direct `recentDecisions`; do not use it to diagnose AAM gateway sideband calls.
- [ ] Inspect the effective root and combining behavior before concluding that a child policy or statement did not work.
