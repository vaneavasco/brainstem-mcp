# ADR 0007 — Tool contract (closed inputs, open outputs, bounded results) and index reconcile

Date: 2026-09-20 · Status: accepted

## Context

A set of multi-step questions was given to fresh models that had only this server's tools and a vault of about 37,000 notes, and the answers were checked against the disk. The answers were right; the contract between the server and its clients was not. Four things went wrong, each observed, none hypothetical:

1. A tool argument the server does not declare was dropped without a word. `vault_frontmatter_update { updates: … }` answered ok and changed nothing; `expected_hash` for `expectedHash` switched the concurrency check of ADR 0006 off for that write.
2. Clients cache the tool list. Output schemas were closed (`additionalProperties: false`), so the first result that carried a field added after the client's copy was rejected whole, with "data must NOT have additional properties" instead of an answer.
3. Clients refuse large results outright: one refused a 59,846-character result, another accepted 120,000. A refused result is worse than a truncated one: the call is spent and nothing arrives. `vault_batch_read` of a dozen long notes, and `vault_query` over a few hundred rows, both hit it.
4. An external job rewrote about 24,000 files in a minute. The file watcher lost events (an inotify queue holds 16,384) and the index served stale frontmatter until a restart, with no sign of it.

## Decision

**Inputs are closed, at every level.** Every tool input is a `z.strictObject`, and so are the nested `where` conditions, sort keys, tags filters, edit patches, transaction ops, batch items and the `vault_links` filter. An unknown key is an error that names the key. The one exception is deliberate and listed in the test that enforces the rule (`tests/tools/surface.test.ts`): JSON Canvas is extensible by design, so a canvas node, edge or patch may carry properties this server does not know, and they are written through unchanged. `z.record` inputs (`set`, template `vars`) are maps, not objects with named keys, and stay maps.

**Outputs are open, at every level.** Every output schema is a `z.looseObject`: a result may gain a field without breaking a client that validates `structuredContent` against the schema it cached yesterday. A test walks every output schema of every tool and fails on a closed node. Removing or renaming an output field remains a breaking change; adding one is not.

**Results are bounded by characters, for the strictest client seen.** One number, 60,000, bounds the payload of a `vault_batch_read` (the note bodies together, shared fairly: a short note leaves its share to the long ones) and of a `vault_query` / `vault_recent` (rows and groups together: groups take what they need, at most half when rows are wanted too; example paths are dropped before groups are; the largest groups survive). A cut is never silent: `truncated` plus a `hint` that says what was cut and what to do. `vault_read` of a single note keeps its 120,000 ceiling and its `maxChars`. The complete match set is a different thing from a presented page of it: code that needs every match (`vault_search` narrowing its candidates) calls `matchEntries`, never the rows of `evaluateQuery`.

**The index reconciles itself with the disk.** `FrontmatterIndex.reconcile` compares a fresh listing (size, mtime: no reads for unchanged files) with the index: what differs is re-read, what is new is added, and what is missing from the listing is removed only after its absence is confirmed on disk, because the listing is a snapshot and a tool may write or move a note while the sweep runs. It runs on a timer (`VAULT_RECONCILE_MS`, default 5 minutes, `0` off, otherwise at least 10 seconds) and when the watcher reports an error; a trigger that arrives during a pass runs one more pass afterwards, error triggers keep 30 seconds apart, a failed pass is reported without its error text (an fs error carries an absolute path), and `close()` waits for the pass in flight. `brainstem_ping`, `/health` and `./brainstem status` show when the index was last checked. Measured on the 37,000-note vault: an idle pass is one directory walk, about one second, and re-reads nothing.

## Consequences

- **Upgrading to the first release with this contract breaks a cached client once.** A client still holding the previous release's closed output schemas rejects the results that carry a new field by default: `brainstem_ping` (always: `index`), a `vault_search` with zero hits (`hint`), a `vault_query` grouped by a list field or cut by the character budget (`hint`). It also does not see new arguments. Reconnecting the connector refreshes the tool list at once; otherwise the list is cacheable for an hour, and how long a given client really keeps it is the client's business. From this release on the class of failure is gone, which is the point.
- **A caller that relied on a dropped argument now fails loudly.** None was found in this repository (`scripts/`, `src/cli/`, README, llms.txt, docker smoke) nor in the one known external integration; that is what the strictness is for.
- **`vault_batch_read` returns less than before for a batch of long notes** (60,000 characters of bodies instead of 120,000). The old budget returned nothing at all to the client that matters most; the intended call for long notes is `sections`.
- **A symlinked note inside the vault** is reachable by path but not part of a directory listing; reconcile keeps it (its absence is never confirmed) at the price of one re-read per pass. Not worth special handling until someone has many.
- **Reconcile is not a substitute for the watcher.** Between two passes the watcher is still what keeps the index current; reconcile bounds how long a lost event can matter.
