# XDRParity Normalization Rules

Every representation difference the comparator deliberately treats as equal
must be documented here — rule ID, what differs, why it is semantically
equal, which SDKs exhibit it — in the same commit that adds the rule to
`harness/src/normalize.ts` (CLAUDE.md invariant 5). Silent allowances are
forbidden: an undocumented pass is worse than a false FAIL.

## Active rules

**None.** The comparator currently applies zero normalization rules.

Canonicalization in `normalize.ts` is exactly: decode via the official
`stellar` CLI, then stable (lexicographic) JSON key ordering. Key ordering is
not a normalization rule — JSON object key order carries no XDR semantics and
exists only so byte-comparison of canonical JSON is well-defined.

This is the desired state, not an omission: across the full 25 × 4 matrix
(JS 17.0.0, Python 15.0.0, Go `v0.0.0-20251210100531-aab2ea4aca88`,
Java 4.0.1), all four
SDKs produce byte-identical envelopes on every valid fixture, so no
representation difference has ever needed to be excused.

## Convention (for when the first real mismatch arrives)

- Rule IDs are `NR-001`, `NR-002`, … in the order they land.
- The implementing code in `normalize.ts` must carry the rule ID in a
  comment at the exact site of the transformation.
- Each rule documented here states: **what differs** (JSON path + both
  representations), **why it is semantically equal** (protocol citation),
  **which SDKs exhibit it** (with pinned versions), and the triage entry in
  `harness/rules/triage.json` that authorized it (label
  `normalization-gap`).
- Audit check: `grep -rn "NR-" harness/src/` must list exactly the rule IDs
  documented in this file. Today that grep must return nothing.
