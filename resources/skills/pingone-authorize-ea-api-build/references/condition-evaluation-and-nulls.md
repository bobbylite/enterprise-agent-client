# Condition Evaluation & Missing Attributes — Read Before Writing Any Conditional Rule

## The finding

If a rule's condition references an attribute (e.g. `department EQUALS "raw_materials"`) and that attribute **does not exist** on the evaluated entity — not empty, not null-valued, genuinely absent, such as a PingOne user with no value ever set for that custom attribute — the JSONPath resolver throws `PROCESSING_ERROR` rather than resolving to a null that the comparator can cleanly evaluate as `false`.

This propagates as follows:
1. The condition's evaluation becomes **indeterminate** (not `true`, not `false` — an error state).
2. Under `FIRST_APPLICABLE` rule combining, an indeterminate result on one rule **halts the entire evaluation chain** — it does not skip to the next rule the way a clean `false` would.
3. The parent policy node's `DENY_OVERRIDES` combining algorithm converts the indeterminate result into a hard **DENY**.

Net effect: a user missing an attribute referenced anywhere in a `FIRST_APPLICABLE` chain gets an unexpected DENY on every request, with no obvious connection in the response to "you're missing an attribute." Confirmed via the PingOne decision visualizer showing `Decision: indeterminate`, error `PROCESSING_ERROR: JSONPath failure for path $['department']`.

## What this does NOT affect

This is specifically about **conditions** (comparators inside a rule's `condition`). It is a different failure mode from what happens when an absent attribute is referenced inside a **statement's** `payload` string for interpolation — that case resolves cleanly to an empty string, no error (see `statements-and-obligations.md`). Don't conflate the two: injecting an absent value is safe; comparing an absent value is not.

## Everything tested as a guard against this, and the results

| Approach | Result |
|---|---|
| `IS_PRESENT` comparator | `INVALID_VALUE` — does not exist in this API |
| `EXISTS` comparator | `INVALID_VALUE` — does not exist |
| `NOT_NULL` comparator | `INVALID_VALUE` — does not exist |
| `NOT_EQUALS ""` (empty string) | Accepted by the API, but still DENIES — indeterminate propagates straight through a `NOT_EQUALS` comparator too |
| `NOT` wrapping `EQUALS` | Accepted, but still DENIES — `NOT(indeterminate) = indeterminate` in this platform's semantics, same as XACML. You cannot invert your way out of a resolution error. |
| `OR(condA, condB)` where at least one branch resolves cleanly | **Works** — if one OR-branch evaluates to `TRUE`, the overall result is `TRUE` regardless of another branch being indeterminate. This is permit-override OR semantics: a resolving `TRUE` branch dominates an indeterminate one. |

**Conclusion: there is no way to guard a single condition against a missing attribute at the policy level.** No presence/existence comparator exists, and negation doesn't rescue an indeterminate.

## The two real mitigations

### Option A — Provisioning discipline (simpler, has an ongoing cost)

Ensure every entity ever evaluated by a policy has a **non-null placeholder value** for every attribute any rule in that policy's chain references, even attributes structurally irrelevant to that entity's role. E.g., in a policy checking both `department` and `vendorAccount` across different rules, a supplier-role user with no natural `department` needs a non-matching placeholder value (e.g. `"vendor"`) set anyway, or they'll be DENIED the moment the chain reaches a rule referencing `department`.

**Cost:** this is a standing operational requirement, not a one-time fix. Every future entity/persona added to the system needs to be checked against every attribute any policy rule references, or they will get a silent, hard-to-diagnose DENY the first time they're evaluated. Document the required attribute set prominently (a checklist, not just narrative documentation) and audit all entities against it whenever policy conditions change.

### Option B — Restructure with `OR` (avoids the provisioning burden, changes the rule shape)

If two rules would otherwise be sequential (`rule[0]: condA`, `rule[1]: condB`, both under `FIRST_APPLICABLE`), and it's acceptable for both paths to converge on the same effect/statements, merge them into a single rule with `condition: OR(condA, condB)`. This avoids ever needing a placeholder value, since an indeterminate branch is rescued by a resolving `TRUE` branch.

**Cost:** this merges what were previously distinguishable match paths into one — if your design needs to know *which* condition matched (e.g. to inject a role-specific value via a statement), a merged OR-rule can't differentiate that inside itself. Only use this when the two paths genuinely share identical downstream behavior.

### Option C — Restructure to avoid referencing a "foreign" attribute at all

If the reason an entity lacks an attribute is architectural (e.g., a rule references `agentRole`, but the calling context makes that attribute fundamentally unavailable/inapplicable for certain request shapes), consider whether the rule design itself should avoid depending on that attribute for that path, rather than working around a missing value after the fact. Sometimes the cleanest fix is realizing the condition shouldn't have needed that attribute in the first place for a given caller type.

## Verification pattern before trusting any conditional rule design

1. Test the condition against an entity that **has** the referenced attribute — confirm it matches as expected.
2. Test against an entity that is genuinely **missing** the attribute (not empty — actually absent) — confirm whether you get a clean fall-through or a DENY. Do not assume symmetry from the first entity's success.
3. If your rule chain has multiple sequential conditions under `FIRST_APPLICABLE`, make sure your test entities actually exercise **every** rule in the chain independently — an entity that matches an early rule will never reach later rules, so it can't tell you anything about their behavior. Pick or construct test entities that fail every earlier rule to get an unconfounded read on a later one.
