# XDRParity — Stellar SDK Conformance Lab

Differential conformance harness proving Stellar SDKs behave identically.
One protocol, many SDKs (JS, Python, Java, Go), one canonical fixture corpus,
one neutral comparator. Every fixture is a fully deterministic transaction —
fixed keypairs, fixed sequence numbers, fixed time bounds, zero network I/O —
built and signed independently by all four SDKs, decoded by the official Rust
`stellar` CLI (never by an SDK under test), and compared byte-for-byte across
five dimensions. Output: a public fixture × SDK conformance matrix.

## Quickstart

```bash
bash scripts/check-env.sh    # node >= 20, python >= 3.11, java >= 17, go >= 1.22, stellar CLI
npm install                  # harness deps

# one-time runner setup
(cd runners/js && npm ci)
(cd runners/python && uv sync)
(cd runners/java && ./gradlew shadowJar)   # go runner builds itself on first run

npm run matrix               # full 25 × 4 run → report/matrix.{json,md,html}
```

Other commands:

```bash
npm run one -- --sdk js --fixture f001      # one cell, raw contract JSON
npm run matrix -- --sdk js --fixture f007   # one cell through the matrix path (debugging)
npm test                                    # harness unit tests
npm run verify-determinism                  # full matrix twice, assert byte-identical
```

## How to read the matrix

Open `report/matrix.md` (or `matrix.html`). Each cell is one fixture built by
one SDK, collapsed to its worst result:

- **PASS** — all five dimensions agree with every other SDK: envelope
  structure, Soroban auth entries, signature payload hash, XDR round-trip
  stability through the official CLI, and error stage on invalid fixtures.
- **FAIL dN** — at least one dimension diverged; `dN` names the worst one
  (3 sig-payload-hash > 2 soroban-auth > 1 structure > 4 round-trip >
  5 error-stage). The cell links to the exact JSON-path diff, with each
  mismatch either carrying a committed triage label
  (`confirmed-divergence` / `normalization-gap` / `runner-bug`, from
  `harness/rules/triage.json`) or marked PENDING.
- **RUNNER-BUG** — the runner violated its contract (bad stdout, nonzero
  exit, or a self-reported hash that fails the harness's independent
  recomputation). That is *our* bug, never SDK divergence.

Confirmed divergences additionally get a minimal reproduction note in
`report/divergences/<id>.md`, ready to paste into an upstream issue. Every
representation difference the comparator deliberately tolerates is documented
in `harness/rules/normalization.md` — currently **zero rules**: all four SDKs
produce byte-identical envelopes on every fixture.

## Adding a new SDK runner

An afternoon of work: a runner is a small single-file CLI (the existing ones
run ~200–600 lines depending on language verbosity) that reads fixture JSON
on stdin and writes `{tx_xdr, sig_payload_hash, error}` on stdout. The whole
interface — field grammars, error stages, determinism rules — is specified in
[`runners/contract.md`](runners/contract.md). Implement it, add an entry to
[`runners/versions.json`](runners/versions.json) with the pinned SDK version
and run command, and the harness picks it up automatically; the matrix grows
a column. The four existing runners (`runners/js`, `runners/python`,
`runners/go`, `runners/java`) are working examples.

## Scope

Offline transaction-**building** parity only: constructing and signing
envelopes. That is the honest boundary — simulation parity (footprints,
resource fees, return values against live nodes) is Phase 2 and deliberately
out of scope, as are CI packaging and SDKs beyond the four named. If it needs
a network call, it does not belong here: a runner that performs any network
I/O is nonconforming by definition (`fixtures/determinism.md`).
