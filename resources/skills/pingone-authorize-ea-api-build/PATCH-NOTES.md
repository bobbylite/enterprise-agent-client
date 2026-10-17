# Patch notes — 2026-09-17

Review-and-patch pass over the 2026-09-03 bundle. No new live testing was performed;
nothing here is new platform evidence. Every change is either an internal-contradiction
fix, a scoping correction, or a de-anonymization cleanup. Where two files disagreed, the
one carrying a dated live result won.

## Corrected contradictions

1. **Direct-endpoint `parameters` examples used friendly keys.** `SKILL.md` and
   `references/decision-endpoints.md` both presented
   `{"judge_risk_score": 42, "refund_count_30d": 1}` as the confirmed request shape,
   while the surrounding prose in three places states the key must literally equal the
   attribute's full Trust Framework name. Both examples now use the namespaced form
   (`Example.judge-risk-score`) with an explicit note that a friendly key yields
   `MISSING_ATTRIBUTE` → `INDETERMINATE`.

2. **`auth-challenge` was simultaneously forbidden and recommended.** The `SKILL.md`
   quick-reference table listed it struck through under "Confirmed NOT working on
   PERMIT — don't retest these", while `statements-and-obligations.md` scopes that
   negative to direct-PDP PERMIT and directs AAM users to `auth-challenge`. The table
   row is now scoped to direct PDP, `auth-challenge` is removed from the struck-through
   list, and a separate AAM challenge/step-up row points at the reference.

3. **The deploy correction had only landed in one file.**
   `references/policy-and-rule-authoring.md` still said AAM API Servers "currently need
   console" and pointed at the file that disproves it.
   Now states the confirmed Worker-Bearer deploy route (2026-08-16) with the console as
   fallback. `ea-api-operational-quirks.md`'s POST-with-parent section had the same
   stale "requires the console step" framing and now points at the `disallowChildren`
   decision tree with the console as fallback.

4. **Duplicate step numbers.** `policy-and-rule-authoring.md` ran 1,2,3,4 then 2,3,4,5
   again — "Step 3" named two different procedures. Renumbered linearly to Step 1–8.
   `scripts/walk_policy_tree.py`'s docstring cross-reference updated to match (Step 2 →
   Step 5) and no longer assumes console creation.

5. **`managedEntity: false` vs. absent.** `SKILL.md` asserted writable child policies
   carry `managedEntity: false`; `policy-and-rule-authoring.md` said they carry no
   `managedEntity` block. Both now say either form can come back and to test for
   "not managed" rather than a literal `false`.

## Scoping and honesty fixes

6. **`authorizationConditions` / `authorizationProcessors` gap is now stated.** New
   section in `ea-api-operational-quirks.md` lists which admin collections this skill has
   actually exercised and which it has not. Records that all conditions here are authored
   inline on rules, that a `403` against `authorizationConditions` has been reported in at
   least one tenant, that the message is PingOne's generic `ACCESS_FAILED` string and
   therefore diagnostically empty, and that the cause is unestablished. Also states
   plainly that a working GET is not write-plane evidence. A matching row was added to the
   `SKILL.md` quick-reference table.

7. **Root-level PUT warning restored.** The Custom-node PUT canary is now explicitly
   scoped to the Custom node, with the earlier `UNEXPECTED_ERROR` result from PUTting the
   AAM root policy with a full tree recorded so nobody widens the target.

8. **`appliesTo` / `appliesIf` enumerations marked open.** Examples throughout use
   `"ANYTHING"` / `"PATH_MATCHES"` with no indication those were the only values tested.
   Now flagged as an open question with the tested values named and an instruction to read
   the tenant schema rather than guess.

9. **Date stamps.** `SKILL.md` carries a "Last verified: 2026-08-31" header and `SHARING.md`
   an evidence-horizon paragraph, both stating that undated claims predate the horizon.
   Deliberately left out of the YAML frontmatter to avoid tripping skill-loader validation
   on an unrecognized key — move it there if the target loader accepts custom keys.

## Cleanup

10. **Dangling file pointers removed.** `SKILL.md` referenced `spikes/spike-01j`,
    `spike-01q`, `spike-01r`, and `authorize-attribute-rehome-log.md`, none of which ship
    in the bundle. Replaced with a note saying they were private working notes, naming
    where their conclusions now live, and telling the reader not to attempt to read them.

11. **Internal shorthand de-anonymized.** "the Spike 01 environment" / "In Spike 01" →
    "a private test tenant". "the live CP2 build" and "CP1/CP2" → described in full on
    first use (two enforcement points in series, each bound to a different OAuth resource).

12. Typo: "from the the reference implementation investigation".

## Deliberately not changed

- **The `description` frontmatter.** It is long (~1,100 chars) and ends with an imperative
  ("Push hard to consult this…") aimed at the model rather than at routing. Editing it
  changes when the skill triggers, which is a behavioral decision, not a copy fix.
- **Every substantive technical claim.** No finding was added, removed, strengthened, or
  softened on my judgment. The `OR`-rescue semantics, the array-indexing gotcha, the
  indeterminate-propagation chain, the introspection recipe, and the canary procedure are
  all as the 2026-09-03 author left them.

## Still open after this pass

- The `type: "RULE"` write-vs-read asymmetry has no recorded provenance — devtools capture
  of a real console request, or a lucky guess. It is stated flatly in two files. Worth
  either confirming or hedging.
- `GET /authorizationRules/{id}` has been reported working for a single resource in one
  tenant, which sits oddly beside this skill's flat claim that
  `GET /authorizationPolicies/{rule-id}` returns `NOT_FOUND`. These may be two different
  collections; nothing here tested the former. Unresolved.
- Whether the Custom-node PUT canary generalizes beyond the one tenant where it was
  confirmed on 2026-08-31.
