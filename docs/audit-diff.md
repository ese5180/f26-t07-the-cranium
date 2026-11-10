# What changed: the activity log's diffs

From console 2.13.1, an entry of the activity log that changed something says what: each field, what it was and
what it is now. On the Activity page such an entry has a "What changed" disclosure under it; opened, it is a grouped
list, a row a field, with "was" before the old value (struck through, on red) and "now" before the new one (on
green). The words say it as well as the colours, the old value is a `<del>` and the new one an `<ins>`, so neither
colour nor sight is needed; the colours are the theme's tokens, so the dark themes have their own, and on a phone
the field goes over its values, each on a line of its own. The overview's short log has no diffs.

## What is recorded

The API's handlers add each change with `change(entry, field, from, to)` (cloud/api/src/lib/audit.mjs), after the
change was made, so a refused request records none. `from` or `to` is null for none: a thing made has no "was", a
thing deleted no "now". An entry is stored with `changes: [{ field, from, to }]`.

| Action | Fields |
| --- | --- |
| `firmware.upload` | status (none to active), notes |
| `firmware.revoke` | status (active to revoked), reason |
| `firmware.notes` | notes |
| `deployment.create` | deployment, version, boards |
| `deployment.cancel` | status (AWS IoT's, to CANCELED, or CANCELED (force)) |
| `token.create` | name, status, expires, token (always hidden) |
| `token.revoke` | status (active to revoked) |
| `alert.subscribe`, `alert.unsubscribe` | alerts (none, pending or confirmed) |
| `alert.rules` | each setting of each rule, as `<rule>_<setting>` (offline_minutes, crashLoop_on) |
| `group.create`, `group.update`, `group.delete` | name, boards |
| `rollout.create` | rollout, version, phase (canary), boards, plan |
| `rollout.cancel` | phase (where it was, to cancelled) |
| `rollout.advance`, `rollout.stop` | phase (canary, waves or stage n; stopped) |
| `fleet.update_everything`, `group.rollback` | a rollout row for each one started, with its release |
| `customer.create` | e-mail address, name, account (invited) |
| `customer.assign`, `customer.unassign` | owner, label |
| `customer.disable`, `customer.enable` | account (enabled or disabled) |

Boards are their thing names, or "N boards" when the names do not fit.

## What is never recorded, and how much is

- A secret. The same denylist as the Database page (lib/db.mjs `secretName`, `secretValue`): a field whose name says
  key, hash, passphrase, passkey, token, certificate and the like, or a value that is an API token, a PEM block or a
  JWT, is kept as `hidden`, with `hidden: true`, never the value. The page shows a "hidden" tag. It is checked again
  when an entry is read, so one that slipped in is hidden on the way out too.
- More than 12 changes, a value longer than 200 characters (it is cut, with an ellipsis), or more than 2,000
  characters in all. What does not fit is counted in `changesOmitted`, and the page says how many were left out.

An entry with no changes is stored exactly as before, with no `changes` attribute, so its digest
(cloud/api/verify-audit.mjs) is unchanged.

## Older entries

An entry of one of these actions from before 2.13.1 has no `changes`. Its disclosure says "No details recorded for
this entry." An entry that did not succeed, or that changes nothing (a sign-in, a download), has no disclosure.

## With the search and filters

The diffs are part of each entry, so they show on any page of the log: searched, filtered by kind, outcome or
dates (docs/search-filters.md), or loaded further back. The search itself still looks at the target, the e-mail
address and the request id, not at the values that changed.
