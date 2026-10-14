# Statements & Obligations

Statement/action support is **policy-model and phase specific**. Do not transfer a statement from a direct Decision Endpoint/PDP policy into an AAM API Service Operation policy without a live test.

| Policy context | Correct starting point for challenge/obligation work |
|---|---|
| Direct Decision Endpoint / PDP | Direct statement model; `modify-query` is live-tested for the documented use cases below |
| AAM API Service → Operation → Inbound/Outbound policy | AAM Operation action/statement model exposed by the AAM policy editor/API; use the AAM-supported `auth-challenge` action/configuration for a challenge/step-up requirement |

A payload can serialize and read back successfully while still being unsupported by the runtime for that policy model. Verify the actual decision path, not just the saved JSON.

## Direct Decision Endpoint/PDP: confirmed `modify-query`

```json
{
  "name": "verify-department",
  "code": "modify-query",
  "obligatory": true,
  "appliesTo": "ANYTHING",
  "appliesIf": "PATH_MATCHES",
  "attributes": [],
  "payload": "{\"department\": \"{{<authorization-attribute-id>}}\"}"
}
```

Key structural facts:
- `payload` is a **JSON string** (not a nested JSON object) containing `{{attribute-uuid}}` interpolation tokens.
- **`attributes` should be left as an empty array `[]`.** It is only a dependency declaration and does not control what gets interpolated — the `{{uuid}}` tokens inside the `payload` string are the only thing that's actually load-bearing. This is a common source of confusion: editing `attributes` while forgetting to also update `payload` silently keeps resolving the old value.
- Attach statements to a **rule**, not the parent policy node — statements at the policy level don't fire the same way.
- `appliesTo: "PERMIT"` (or `"ANYTHING"`, tested working) determines when the statement fires relative to the decision.
- **Open — the full enumerations of `appliesTo` and `appliesIf` are unverified.** The only values live-tested here are `appliesTo: "ANYTHING"` and `appliesTo: "PERMIT"`, and `appliesIf: "PATH_MATCHES"`. `"DENY"` is discussed below as explicitly untested territory. Other values may well exist. Do not assume this is the complete set, and do not guess at one — read it off the target tenant's schema or the AAM editor, then GET the saved statement back and confirm it persisted as sent.
- The interpolated value must resolve to a **scalar**. If the referenced attribute resolves to a non-scalar (an object, or an un-indexed array — see the array-wrapping gotcha in `resolvers-and-attributes.md`), the statement throws `500 UNEXPECTED_ERROR` rather than failing gracefully or interpolating something reasonable. A cleanly-absent/null value interpolates to an empty string with no error — it's specifically a *present-but-non-scalar* value that breaks it.

## AAM API Service Operations: `auth-challenge`

For AAM API Service → Operation rules, do not use the direct-PDP `modify-query` recipe as a substitute for a challenge. The AAM editor exposes an AAM-specific `auth-challenge` action/configuration (the exact fields can vary with the EA schema and tenant). Use the AAM UI/schema as the source of truth for the action shape, then GET the saved policy and validate the inbound decision in the Decision Visualizer. Confirm how the gateway/plugin handles the challenge response before production deployment.

The direct-PDP tests below do **not** prove that `auth-challenge` is unsupported in AAM. Earlier negative results for `auth-challenge` were scoped to direct Decision Endpoint/PERMIT experiments and must not be generalized across policy models.

## Direct-PDP tests: codes not confirmed on PERMIT

**Scope of this result: the direct Decision Endpoint/PDP model, `appliesTo: PERMIT`, in the EA generation tested.** It is not a statement about the AAM Operation model — see the `auth-challenge` section above before carrying any of this across.

All five tested live, multiple configurations, including with correctly-resolving Trust Framework attributes:

- `custom-attributes`
- `set-header`
- `url-rewrite`
- `add-query-parameters`
- `auth-challenge`

If you need behavior that sounds like one of these (e.g., "set a response header," "reject with a custom challenge"), it does not currently work via a PERMIT-side statement in this API generation. `modify-query` is the confirmed, working injection mechanism — if your use case can be reshaped as "inject a query parameter the downstream service reads," that's the path that works.

## AAM obligation troubleshooting

A live AAM test showed that a direct-PDP-style `modify-query` marker could be correctly saved and deployed yet return HTTP 500 `UNEXPECTED_ERROR` on a matching human-direct AAM request, with no backend hit. Treat this as a policy-model/action execution mismatch until proven otherwise. Inspect the inbound AAM Decision Visualizer trace and gateway/plugin debug logs; do not reinterpret the 500 as a policy placement failure or claim a clean step-up result from the HTTP status alone. Use the AAM `auth-challenge` action/configuration for AAM challenge behavior, and reserve the `modify-query` recipe for the direct-PDP context where it was tested.

## Direct response shape for statements

A direct Decision Endpoint response can surface a rule statement under `statements` with fields such as `name`, `code`, `payload`, `obligatory`, and `fulfilled`. In live tests, both `custom-attributes` and `auth-challenge` were accepted on a DENY rule and returned as generic statement entries; `auth-challenge` did not produce a separate structured challenge object. A payload containing keys named `errorCode` or `errorDescription` likewise remained arbitrary payload data, not reserved top-level or status fields.

## `custom-attributes`/`set-header`/etc. on other appliesTo values

These were only tested on `PERMIT`. If a future need requires testing them on a different `appliesTo` (e.g. `DENY`), that's genuinely untested territory — don't assume the same negative result carries over without checking, but also don't assume it'll suddenly work either. Verify live.

## Debugging a statement that isn't firing

In order of likelihood, based on repeated live incidents:

1. **The `payload` string still references the old/wrong attribute UUID**, even though the `attributes` array looks right. Re-GET and read the literal `payload` string.
2. **The interpolated value is an array or object, not a scalar** — check the source attribute against the array-wrapping gotcha in `resolvers-and-attributes.md`. Symptom: `500 UNEXPECTED_ERROR`, but only when the underlying value is actually present (absent/null values interpolate fine as empty string).
3. **Deploy hasn't landed.** Confirm `authorizationVersionId` changed since your last PUT, per `ea-api-operational-quirks.md`.
4. **The rule containing the statement never matched** — check the rule's `condition` and see `condition-evaluation-and-nulls.md` if it involves any attribute that might be missing (not just empty) on the evaluated entity.
