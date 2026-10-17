# Sharing and portability notes

This skill is written as a tenant-neutral operational guide for PingOne Authorize Early Access Admin API work. It contains live-tested observations, not a guarantee that every EA tenant or API generation exposes identical behavior.

**Evidence horizon: 2026-08-31.** That is the date of the newest live confirmation in the bundle; the files were last edited 2026-09-17. Dated findings carry their own date inline. An undated claim predates the horizon and has not been re-confirmed since. When sharing, say so — a recipient who assumes these are current platform facts will eventually get burned by an EA change.

## Before sharing

- Share this skill directory together with `SKILL.md`, `references/`, and `scripts/`.
- The bundle is exactly: `SKILL.md`, `SHARING.md`, `PATCH-NOTES.md`, `references/` (7 files), `scripts/walk_policy_tree.py`. There are no `spikes/` files and no attribute-rehome log in a shared copy; if a reference to one reappears, it leaked back in from private notes and should be removed.
- Do not include tenant exports, audit logs, screenshots containing identifiers, bearer tokens, client secrets, gateway credentials, refresh tokens, or raw introspection responses.
- Keep private tenant-specific evidence in a separate document that is not bundled with the shared skill.
- Review the current PingOne Authorize EA API documentation and tenant permissions before using any write example.

## Required inputs for a new tenant

Replace all placeholders before making calls:

- `<environment-id>`
- `<api-server-id>`
- `<operation-id>`
- `<custom-node-id>`
- `<authorization-attribute-id>`
- `<oauth-resource-id>`
- `<decision-endpoint-id>`
- `<gateway-credential>`

The operator needs an active PingOne environment, an OAuth worker or equivalent client with the required Authorize/Management API permissions, and a valid caller token for runtime testing. The caller token must have the audience and scope expected by the API Service under test.

## Portability rules

- Treat the direct PUT child-creation route for AAM Custom nodes as a canary: use it only after GET confirms `disallowChildren: false`, preserve the current version, and verify placement with a follow-up GET.
- If the canary is rejected, use the console-created skeleton-policy fallback.
- Treat all live observations as tenant/version scoped until independently reproduced.
- Use a tenant-safe temporary naming prefix and record cleanup actions for test resources.
- Redact sensitive fields before printing or saving API output.

## Statement model warning

Direct Decision Endpoint/PDP policies and AAM API Service Operation policies are different policy models. The direct-PDP `modify-query` examples must not be copied into AAM rules. For AAM challenge or step-up behavior, use the AAM-supported `auth-challenge` action/configuration exposed by the AAM policy editor/API, then verify the inbound decision in the Decision Visualizer and the actual gateway/plugin response.
