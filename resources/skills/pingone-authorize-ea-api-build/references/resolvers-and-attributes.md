# Trust Framework Attribute Resolvers

Attributes are created via `POST /environments/{envId}/authorizationAttributes`. This file covers what resolver type to use for each kind of source data, and the single most expensive-to-discover gotcha in this whole skill: array-wrapping on Query Parameters and Headers.

## The critical gotcha: array-wrapping on Query Parameters and Request Headers

**Path Parameters, Query Parameters, and Request Headers are NOT structurally identical, even though they look like they should be.**

Confirmed via extensive live, harness-verified testing (payload string double-checked, deploy confirmed via `authorizationVersionId` on every test):

- **Path Parameters** (`PingOne.API Access Management.HTTP.Request.Path Parameters`) resolves via `{"type": "REQUEST"}` — a direct resolver — to a plain object: `{"vendorId": "6"}`. A child attribute with JSONPath `$.vendorId` extracts the scalar `"6"` correctly. **No array index needed.**
- **Query Parameters** and **Request Headers** resolve to an object whose **values are arrays**: `{"vendorId": ["6"]}`, not `["6"]` and not `[{"vendorId":"6"}]`. A JSONPath of `$.vendorId` (no index) returns the array `["6"]` itself — not the scalar. If that array-valued result reaches a `modify-query` statement's interpolation, it throws `500 UNEXPECTED_ERROR` (the obligation cannot interpolate a non-scalar into a `{{uuid}}` placeholder in the payload string). **The fix is `$.vendorId[0]`** (Query Parameters) or `$['x-header-name'][0]` (Headers) — explicitly index into the value array to get the scalar.

**A hypothesis that was tested and falsified, worth knowing so it doesn't get resurrected:** it's tempting to think this is about resolver chain type — Path Parameters uses a direct `{"type": "REQUEST"}` resolver, so maybe indirect/chained resolvers are the problem. This was directly tested: Request Headers *also* resolves via `{"type": "REQUEST"}` (confirmed by GETting the system attribute definition directly) and *still* requires `[0]`. **The cause is the array-valued internal representation specifically, not resolver chain type.** Don't waste time investigating chain type as an explanation for a similar failure elsewhere — check for array-wrapping first.

**Symptom checklist if you hit an unexplained `500 UNEXPECTED_ERROR` from a `modify-query` (or similar) statement when the source value IS present, but it works fine (empty string) when absent:** this is almost certainly the array-wrapping issue. Add `[0]`.

## Direct Decision Endpoint `parameters`: processor-free REQUEST recipe

For a plain direct Decision Endpoint, a `REQUEST` resolver can consume a runtime parameter, but the working contract is not the same as an AAM HTTP request attribute and is not documented in the public schema. The live-confirmed recipe is:

```json
{
  "name": "risk-score",
  "type": "ATTRIBUTE",
  "parent": {"id": "<normal-non-AAM-parent-id>"},
  "resolvers": [{"type": "REQUEST"}],
  "valueType": {"type": "NUMBER"}
}
```

- Put the attribute under a normal Trust Framework parent, not the managed `PingOne.API Access Management` hierarchy. Placement itself was not conclusively isolated as the cause, but this is the confirmed working placement.
- **Do not add a `processor`.** A JSONPath/type-conversion processor runs after `REQUEST` has already returned the scalar and attempts to parse that scalar as nested JSON, causing `TYPE_CONVERSION_ERROR`.
- The `parameters` key must be the attribute's own full name, literally (for example, `Example.risk-score`), not a friendly key such as `riskScore`.
- The parameter must use the declared JSON type: a JSON number for `valueType: NUMBER`, not a quoted string.

Example request:

```json
{
  "parameters": {"Example.risk-score": 90},
  "userContext": {"user": {"id": "<uuid>"}}
}
```

A mismatched key produces `MISSING_ATTRIBUTE` and the compact direct response becomes `INDETERMINATE`. With the matching full name and no processor, a live `GREATER_THAN 50` condition returned `DENY` at `90` and `PERMIT` at `10`.

This behavior is distinct from AAM path/query/header resolvers below, which use request-context structures and may require JSONPath processors and array indexing.

## AAM built-in access-token claims can be reused directly

The managed attribute `PingOne.API Access Management.Identity.Access Token` is a JSON object representing the validated inbound token. Its built-in child `Client ID` uses an `ATTRIBUTE` resolver and JSONPath `$.client_id`. In a live AAM test, a project-namespaced child attribute copied that same pattern and resolved the caller discriminator without a second RFC 7662 service call. Before creating a redundant SERVICE resolver, GET the built-in Access Token/Client ID attributes directly and verify that the target AAM sideband context populates them. This is especially useful for agent-vs-human policy decisions: `client_id` is present on both human and agent tokens, unlike `act.sub`, which is absent on a direct human token and can trigger missing-attribute/indeterminate behavior.

## Platform-verified actor identity via SERVICE introspection

Use this when a policy must consume a genuine token claim rather than an app-computed value. The proven pipeline is:

```text
full-name-keyed REQUEST token attribute
  → top-level HTTP SERVICE → RFC 7662 /as/introspect
  → SERVICE resolver + JSON_PATH $.act.sub
  → COMPARISON condition
```

The HTTP service must be top-level in the Services hierarchy (`parent` omitted), not nested under the Example attribute parent. Its Basic-auth `name.id` and `password.id` must be IDs of real Authorize Trust Framework Definitions holding the OAuth resource client ID and secret; the OAuth resource ID itself is not a Definition ID. Use a body such as `token={{<token-attribute-uuid>}}`. The token parameter must be a nonempty actual token. An empty string resolves as a string but makes `/as/introspect` return `400 No value supplied for required parameter: token`, which propagates as `PROCESSING_ERROR`/`INDETERMINATE`.

Example downstream attribute:

```json
{
  "resolvers": [{"type": "SERVICE", "value": {"id": "<service-id>"}}],
  "processor": {"type": "JSON_PATH", "expression": "$.act.sub", "valueType": {"type": "STRING"}},
  "valueType": {"type": "STRING"}
}
```

Use `authentication.type: BASIC`, not `CLIENT_CREDENTIALS`; the latter adds an unnecessary token acquisition step and produced `invalid_client` for the tested introspection resource. This live-confirmed recipe produced `DENY` for a matching actor and `PERMIT` for a nonmatching actor. Official sources: [Token Introspection](https://developer.pingidentity.com/pingone-api/auth/openid-connect-oauth-2/token/token-introspection-resource-id-and-secret.html), [Create Authorization Service](https://developer.pingidentity.com/pingone-api-ea/authorize/early-access/pingone-authorize-admin-apis/pingauthorize-trust-framework/authorization-services/create-authorization-service.html), and [Authorization Attributes](https://developer.pingidentity.com/pingone-api-ea/authorize/early-access/pingone-authorize-admin-apis/pingauthorize-trust-framework/authorization-attributes.html).

## Resolver types, when to use each

### `REQUEST` — direct resolvers

Path Parameters, Request Headers, and the base URL/query-parameters system attributes all resolve this way — no chaining through another custom attribute. Fastest, least error-prone. Prefer building child attributes directly off these system attributes rather than introducing extra indirection.

### `ATTRIBUTE` — chained resolvers

A custom attribute can resolve by referencing another attribute (`{"type": "ATTRIBUTE", "value": {"id": "<parent-attribute-uuid>"}}`) and applying its own `processor` (typically `JSON_PATH`) on top of the parent's resolved value. This is how Query Parameters itself is built internally (chained off the URL attribute) — you don't need to replicate that; just build your own child attribute directly off the `Query Parameters` system attribute's UUID with the `[0]`-indexed JSONPath.

### PingOne User resolver — for user custom attributes

If you need a value off the PingOne user object (a custom attribute like `department` or `vendorAccount`), use the **PingOne User** resolver type directly — do **not** build an HTTP Service workaround for this. It's a first-class, direct resolution path. Typically keyed off a `personSub` attribute (itself an `AccessToken` JSONPath resolver on `$.sub`) to identify which user to look up.

### HTTP Service resolver — for anything requiring a lookup against your own backend

When a value needs to come from your own API rather than the token or request context (e.g., "what category does this vendor belong to, given its ID"), use an HTTP Service resolver — configure it to call your endpoint (e.g. `GET /internal/vendor-category?vendorId={requestedVendorId}`), chaining off whatever attribute supplies the input parameter. This is the same general pattern used for role-lookup-style attributes keyed off a client ID or subject.

### Generated attributes

PingOne can auto-generate a child attribute for a JSON property under a parent attribute or service, adding the JSON Path processor automatically. If the parent has nested properties, generate one level at a time — parent first, then child. Useful as a starting point, but always verify the generated expression against the array-wrapping gotcha above before trusting it on Query Parameters or Headers.

### Operation path-parameter attributes

If an API Operation's path includes a `{paramName}` segment (e.g. `/records/user/{userId}`, configured via `paths: [{type: "PARAMETER", pattern: "..."}]` on the Operation), PingOne automatically populates the Path Parameters attribute for that Operation's requests — this is the mechanism, not something you configure separately per-attribute. This is structurally distinct from a generic top-level Path Parameters check — it's populated specifically because the matched Operation's path pattern declared that parameter.

## Verification pattern for any new attribute

1. `GET` it directly after creation, confirm the `id` and resolver/processor fields match intent.
2. Wire it into a throwaway `modify-query` statement on a test rule (see `policy-and-rule-authoring.md`), with a distinct payload key so its output is unambiguous.
3. Deploy, confirm `authorizationVersionId` changed.
4. Test with the value present and absent, via a real sideband/decision-endpoint call. Print the full raw response.
5. Only then wire it into real policy logic.
