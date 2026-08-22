# XDRParity Runner Contract

One runner per SDK. A runner is a small CLI: **fixture input JSON on stdin,
result JSON on stdout**. That is the entire interface — the harness treats
every runner as a black box, and adding a new SDK to the matrix means
implementing this one contract (target: an afternoon, ~150 lines).

The output shape is CLAUDE.md invariant 3, quoted verbatim below. Changing
this contract requires updating this file, all four runners, and the harness
in the same commit.

## Invocation rules

- The harness pipes **one JSON document (UTF-8) to stdin** and reads
  **exactly one JSON document (UTF-8) from stdout**. Nothing else may be
  written to stdout — banners, progress, or debug output there violate the
  contract.
- **stderr** is free-form logging. The harness ignores it (it is kept in run
  artifacts for humans).
- **Exit code 0 even on fixture errors** — an expected rejection is data,
  reported in the `error` field. A nonzero exit or unparseable stdout is a
  contract violation, recorded as a *runner-bug* cell, never as an SDK
  divergence.
- One transaction per invocation. Runners are stateless: no caches, no
  config files, no environment-dependent behavior (no platform default
  charsets, no locale-dependent parsing).
- **No network I/O of any kind** (`fixtures/determinism.md`, rule 2).
- Every field shown in the input example is **required**; a missing field is
  stage `parse`. Runners MUST **ignore unknown fields** at every level
  (forward compatibility — the harness may add fields without a contract
  bump).

## Input JSON

```json
{
  "fixture_id": "f001",
  "network_passphrase": "Test SDF Network ; September 2015",
  "tx": {
    "source_account": "GDVTHGAKUSGSMVXGLSU5LIR3VBYE36MKGW443HBARQIAPE6SEZGHEJLC",
    "seq_num": "103720918407356415",
    "fee": 100,
    "time_bounds": { "min_time": 1735689600, "max_time": 1893456000 },
    "memo": { "type": "none" },
    "operations": [ /* fixture operations, verbatim — see below */ ]
  },
  "signers": [
    { "label": "alice", "secret_seed": "SCNNJVGY4WCY3QCMJB4S3M2CJVUXCT5Y6VHT7VC3LUXSYG363SBMCOPA" }
  ]
}
```

### Field rules

- `seq_num` — decimal **string** matching `^[1-9][0-9]*$` (no sign, no
  leading zeros, no whitespace), value in `[1, 2^63 − 1]`. Anything else is
  stage `parse`. This is the value that must appear in the envelope's
  `seqNum` field; committed values are always ≥ 1, so `seq_num − 1` is
  always a valid "current sequence" for auto-incrementing builders
  (`fixtures/determinism.md`, rule 4).
- `fee` — JSON number (uint32). It is the **total fee that must appear in
  the envelope's `fee` field**, exactly. Note: every mainstream SDK builder
  takes a *per-operation base fee* and multiplies by the operation count —
  runners using such builders must feed `fee / operation_count`. Valid
  fixtures guarantee `fee` is divisible by the operation count and that
  there are 1–100 operations. An envelope fee of `fee × N` is a runner-bug.
- `time_bounds` — **required**, both fields, JSON numbers, with
  `1 ≤ min_time ≤ max_time` guaranteed by valid fixtures (`0` is never
  committed — it means "unbounded" in the protocol). Missing or partial
  `time_bounds`, or `min_time > max_time`, is stage `parse`; the value
  floor is a fixture guarantee, not a runner check.
- `memo` — `{ "type": "none" }`, `{ "type": "text", "value": "…" }`,
  `{ "type": "id", "value": "…" }`, `{ "type": "hash", "value": "<64 hex>" }`,
  or `{ "type": "return", "value": "<64 hex>" }`.
  - **text**: the value is encoded to bytes as **UTF-8** — never a platform
    default charset. Valid fixtures guarantee ≤ 28 UTF-8 bytes; a longer
    value is stage `parse`.
  - **id**: decimal string matching `^(0|[1-9][0-9]*)$`, full **uint64**
    range — values above `2^63 − 1` appear in fixtures, so parse unsigned
    (Java `Long.parseUnsignedLong`, Go `strconv.ParseUint`). Outside the
    grammar is stage `parse`.
- **Amounts** (`amount`, `starting_balance`, `limit` — the complete list,
  per `fixtures/schema.md`): quoted strings matching
  `^(0|[1-9][0-9]*)\.[0-9]{7}$` — exactly 7 decimal places, no sign, no
  exponent, no leading zeros — value ≤ `922337203685.4775807`. `0.0000000`
  appears only as a `change_trust` delete-limit. Runners MUST pass the
  string **unchanged** to the SDK's decimal-string amount API and MUST NOT
  route it through binary floating point at any step (float64 cannot hold
  19 significant digits). A string outside the grammar is stage `parse`;
  an in-grammar amount the SDK rejects is stage `build`.
- **Addresses** — passed through verbatim to the SDK (`G…`, muxed `M…`,
  contract `C…`, including deliberately broken ones). Runners MUST NOT
  pre-validate strkey checksums — SDK rejection is stage `build`, and that
  detection behavior is part of what the matrix measures. Muxed `M…` values
  appear only where a fixture commits one (payment destinations); the `M`
  address must survive into the envelope bytes — demuxing to its `G` is a
  runner-bug.
- `operations[]` — passed through **verbatim** as the JSON rendering of the
  fixture YAML. Operation shapes (including the ScVal notation) are defined
  once, in `fixtures/schema.md`, and apply to both the YAML fixtures and
  this JSON identically. Key order is never significant.
- `signers[]` — the harness has already resolved keypair labels to seeds
  (runners never see `determinism.md`). Sign in exactly this order, via the
  SDK's standard transaction-sign API — each signature is a
  `DecoratedSignature` whose hint is the last 4 bytes of the signer's
  ed25519 public key. Hand-rolled signing or decoration is nonconforming.

## Output JSON (CLAUDE.md invariant 3 — verbatim)

```json
{"tx_xdr": string|null, "sig_payload_hash": string|null, "error": {"stage": "parse|build|sign", "message": string}|null}
```

Success:

```json
{
  "tx_xdr": "<base64 TransactionEnvelope>",
  "sig_payload_hash": "<64 lowercase hex characters>",
  "error": null
}
```

Error:

```json
{
  "tx_xdr": null,
  "sig_payload_hash": null,
  "error": { "stage": "build", "message": "free text — never compared across SDKs" }
}
```

- `tx_xdr` — the signed envelope, `ENVELOPE_TYPE_TX`, base64 per RFC 4648
  §4: standard alphabet, **with padding, as a single line** — no line breaks
  or whitespace anywhere (Java: `Base64.getEncoder()`, never
  `getMimeEncoder()`; Python: `b64encode`, never `encodebytes`).
- `sig_payload_hash` — SHA-256 of the `TransactionSignaturePayload` XDR:
  `network id (32 bytes) ‖ ENVELOPE_TYPE_TX (4 bytes) ‖ Transaction`.
  This is the hash the signatures actually sign; every SDK exposes it
  (e.g. `tx.hash()`). Lowercase hex, no prefix. The harness *recomputes*
  this independently from the decoded envelope (CLAUDE.md invariant 6) —
  a mismatch with the runner's self-reported value is a runner-bug.
- SDK name/version is **not** part of the output — `runners/versions.json`
  is the single source of truth (CLAUDE.md invariant 4).

## Error stages — defined by phase, not by error kind

`stage` is the only compared field (dimension 5 measures *that* an SDK
rejected and *where*, never the wording). A stage is determined by **which
phase of the runner raised the error**:

| stage   | phase |
|---------|-------|
| `parse` | the runner's own mandatory input validation, **before the first SDK call** |
| `build` | any error raised by the SDK while constructing operations or the transaction |
| `sign`  | any error raised after a successful build, while signing |

The `parse` checklist is **normative and complete** — runners validate
exactly this, and nothing more:

1. stdin is well-formed JSON and every required field is present;
2. the operation `type` is one of the six the schema defines: `payment`,
   `create_account`, `change_trust`, `set_options`,
   `create_claimable_balance`, `invoke_contract`;
3. `seq_num` matches its grammar and range;
4. `time_bounds` is present with `min_time ≤ max_time`;
5. `memo.type` is known; memo text ≤ 28 UTF-8 bytes; memo id matches its
   grammar;
6. amounts match the amount grammar.

Everything else — strkey checksums, asset-code validity, ScVal ranges — is
deliberately left to the SDK, so rejection behavior lands in `build` and is
measured. Adding extra pre-validation hides SDK behavior and is
nonconforming. Failures in the runner's own JSON→SDK marshalling during
construction (an unknown ScVal tag, a wrong-typed payload, invalid hex in a
memo hash) also land in `build`: they arise in the build phase, and no
conforming fixture produces them. Runners must force any lazy SDK
serialization to complete inside the build phase (e.g. by hashing the built
transaction) so deferred validation cannot leak into `sign`.

## Worked example

Input (a complete f001-style native payment, alice → bob):

```json
{
  "fixture_id": "f001",
  "network_passphrase": "Test SDF Network ; September 2015",
  "tx": {
    "source_account": "GDVTHGAKUSGSMVXGLSU5LIR3VBYE36MKGW443HBARQIAPE6SEZGHEJLC",
    "seq_num": "103720918407356415",
    "fee": 100,
    "time_bounds": { "min_time": 1735689600, "max_time": 1893456000 },
    "memo": { "type": "none" },
    "operations": [
      {
        "type": "payment",
        "destination": "GD736ZDG6TG24DDM4G42K3DKUJKDEOAD5ECAJHRGE5YWN2N2SWIPW53D",
        "asset": { "type": "native" },
        "amount": "125.5000000"
      }
    ]
  },
  "signers": [
    { "label": "alice", "secret_seed": "SCNNJVGY4WCY3QCMJB4S3M2CJVUXCT5Y6VHT7VC3LUXSYG363SBMCOPA" }
  ]
}
```

Expected output shape (byte-exact values are fixture-dependent; the
reference values for every fixture are produced by the JS reference runner):

```json
{
  "tx_xdr": "AAAAAgAAAADr…  ← base64 TransactionEnvelope, single line, deterministic",
  "sig_payload_hash": "…64 lowercase hex chars, must equal the harness's recomputation…",
  "error": null
}
```
