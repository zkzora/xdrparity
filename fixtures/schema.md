# XDRParity Fixture Schema

Fixtures are YAML, one transaction per file: `fixtures/valid/f001.yaml` …
`f020.yaml` and `fixtures/invalid/e001.yaml` … `e005.yaml`. The filename
(minus extension) must equal the fixture's `id`.

**Minimality rule:** this schema defines exactly what the current 25 fixtures
need — nothing more. A new field or type may only be added together with a
fixture that uses it.

## Top-level fields

| field | type | notes |
|-------|------|-------|
| `id` | string | `f###` (valid) or `e###` (invalid); must match filename |
| `title` | string | human description, harness-only |
| `protocol_version` | int | protocol the fixture targets (e.g. `28`), informational pin |
| `source_account` | account ref | see *Account references* below |
| `seq_num` | int64 literal | the value that must appear in the envelope (`determinism.md` rule 4) |
| `fee` | uint32 literal | total tx fee, used as-is |
| `time_bounds` | map | `{ min_time, max_time }`, absolute unix timestamps |
| `memo` | map | `{ type: none }` \| `{ type: text, value: … }` \| `{ type: id, value: "…" }` \| `{ type: hash, value: "<64 hex>" }` \| `{ type: return, value: "<64 hex>" }` — `id` value is a quoted decimal string (uint64) |
| `operations` | list | typed operations, see below; valid fixtures always commit 1–100 operations and a `fee` divisible by the operation count |
| `signers` | list of labels | which keypairs sign, **in this order** |
| `expect` | `valid` \| `error` | `error` fixtures live in `fixtures/invalid/` |

`title`, `protocol_version`, and `expect` are harness-only — they are not
sent to runners (see *YAML → runner JSON* below).

## Common conventions

- **Account references** — anywhere an account is expected
  (`source_account`, `destination`, `issuer`, per-operation `source`, signer
  keys, auth `address`, and ScVal `address` payloads — the complete list):
  a value that matches a keypair label from `fixtures/determinism.md`
  (`alice`, `bob`, `carol`, `dave`) is resolved by the harness to that
  keypair's public key; any other value is passed through **verbatim** as an
  address (`G…`, muxed `M…`, contract `C…` — including deliberately broken
  ones in invalid fixtures).
- **Amounts** — exactly these three fields are amounts: `amount`,
  `starting_balance`, `limit`. Quoted strings matching
  `^(0|[1-9][0-9]*)\.[0-9]{7}$` (exactly 7 decimal places, no sign, no
  exponent, no leading zeros), value ≤ `922337203685.4775807`;
  `"0.0000000"` appears only as a `change_trust` delete-limit. Full rules
  in `runners/contract.md`.
- **Big integers** (`seq_num` excepted, which is a YAML int literal): any
  value that can exceed 2^53 (`i128`, memo `id`) is a quoted decimal string.
  Memo `id` spans the full uint64 range — values above 2^63 − 1 are legal,
  though no current fixture commits one (runners must still parse unsigned,
  per `runners/contract.md`).
- **Assets**:

  ```yaml
  asset:
    type: native
  # or
  asset:
    type: credit
    code: USDC          # 1–4 chars → alphanum4, 5–12 → alphanum12
    issuer: bob
  ```

## Operations

Every operation is a map with a `type` field. An optional `source` field
(account ref) sets the per-operation source account; omitted means the
transaction source.

### payment

```yaml
- type: payment
  destination: bob            # label, G…, or M… (muxed)
  asset: { type: native }
  amount: "125.5000000"
```

### create_account

```yaml
- type: create_account
  destination: carol
  starting_balance: "100.0000000"
```

### change_trust

```yaml
- type: change_trust
  asset: { type: credit, code: USDC, issuer: bob }
  limit: "5000.0000000"       # "0.0000000" = delete trustline; always explicit
```

### set_options

All fields optional; a fixture commits only the ones it exercises.

```yaml
- type: set_options
  master_weight: 1
  low_threshold: 1
  med_threshold: 2
  high_threshold: 3
  home_domain: "example.com"
  signer:
    key: carol                # ed25519 signer only (label or G…)
    weight: 1                 # 0 = remove signer
```

### create_claimable_balance

```yaml
- type: create_claimable_balance
  asset: { type: native }
  amount: "50.0000000"
  claimants:
    - destination: bob
      predicate: unconditional
    - destination: carol
      predicate:
        abs_before: 1893456000   # BEFORE_ABSOLUTE_TIME, unix ts literal
```

Predicates needed by the corpus: `unconditional` and `abs_before`. Nothing
else is defined.

### invoke_contract (Soroban)

```yaml
- type: invoke_contract
  contract: CB64D3G7SM2RTH6JSGG34DDTFTQ5CFDKVDZJZSODMCX4NJ2HV2KN7OHT
  function: transfer
  args:                       # list of ScVals, notation below
    - address: alice
    - address: bob
    - i128: "500000000"
  auth: []                    # list of auth entries, notation below
```

## ScVal notation

*(decided 2026-08-22: tagged one-key maps)* — each ScVal is a **single-key
YAML map**: the key is the type tag, the value is the payload. This renders
1:1 into the runner input JSON (`{ "u32": 7 }`).

| tag | payload | example |
|-----|---------|---------|
| `u32` | bare int, 0 … 4294967295 | `- u32: 7` |
| `i128` | **quoted decimal string**, range ±2^127 (min −2^127, max 2^127−1); out-of-range must be rejected by runners (e005) | `- i128: "170141183460469231731687303715884105727"` |
| `symbol` | bare string, ≤ 32 chars of `[a-zA-Z0-9_]` | `- symbol: transfer` |
| `address` | account ref (label, `G…`, `C…`, or `M…`) | `- address: alice` |
| `vec` | list of ScVals (recursive) | see below |
| `void` | `null` (write `void:` or `void: null`) | `- void: null` |

```yaml
args:
  - vec:
      - u32: 1
      - u32: 2
      - symbol: end
```

These six tags are the entire ScVal surface the corpus needs. No other tags
are defined.

## Soroban authorization entries

An auth entry commits its credentials and its invocation tree. Everything is
a fixed literal — no simulation, no network (`determinism.md` rule 8).

```yaml
auth:
  # source-account credentials: authorized by the tx signature itself
  - credentials: source_account
    invocation:
      contract: CB64D3G7SM2RTH6JSGG34DDTFTQ5CFDKVDZJZSODMCX4NJ2HV2KN7OHT
      function: transfer
      args:
        - address: alice
        - i128: "500000000"
      sub_invocations: []

  # address credentials: arm, nonce + expiration committed in the fixture
  - credentials:
      type: address_v2                  # required: address | address_v2
      address: carol
      nonce: 123456789                  # int64 literal
      signature_expiration_ledger: 500000
    invocation:
      contract: CB64D3G7SM2RTH6JSGG34DDTFTQ5CFDKVDZJZSODMCX4NJ2HV2KN7OHT
      function: approve
      args:
        - address: carol
      sub_invocations:                  # nested invocation auth tree
        - contract: CB64D3G7SM2RTH6JSGG34DDTFTQ5CFDKVDZJZSODMCX4NJ2HV2KN7OHT
          function: burn
          args:
            - i128: "1"
          sub_invocations: []
```

The credentials `type` selects the `SorobanCredentials` union arm and has no
default — an implicit arm would be exactly the kind of ambiguity a byte-parity
spec cannot allow:

| `type` | XDR arm | corpus |
|--------|---------|--------|
| `address` | `SOROBAN_CREDENTIALS_ADDRESS` (legacy preimage, still valid — CAP-71-02 does not deprecate it) | f016 |
| `address_v2` | `SOROBAN_CREDENTIALS_ADDRESS_V2` (CAP-71-02 address-bound preimage, protocol 27+; the SDKs' default since protocol 28) | f017 |

Both arms carry the same `SorobanAddressCredentials` struct; only the
discriminant differs. `SOROBAN_CREDENTIALS_ADDRESS_WITH_DELEGATES` is not
defined — no fixture uses it.

Address-credential entries are committed **unsigned**: the credentials'
`signature` ScVal is `void`. Cross-SDK parity is measured on the auth
*structure*; deterministic offline auth-signing is future scope and would be
specified here first.

## YAML → runner JSON

The harness transforms a fixture into the runner input
(`runners/contract.md`) as follows — and does nothing else:

1. `id` → `fixture_id`; `network_passphrase` injected from
   `determinism.md`.
2. Every account ref that matches a keypair label → that keypair's public
   key (strkey). All other strings verbatim.
3. `signers` labels → `[{ label, secret_seed }]` from `determinism.md`.
4. `seq_num` int literal → decimal **string**.
5. `title`, `protocol_version`, `expect` dropped (harness-only).
6. Everything else — operations, ScVals, auth entries — passes through
   **verbatim** as the JSON rendering of the YAML.

## Complete example (f001-style)

```yaml
id: f001
title: native payment, alice pays bob
protocol_version: 28
source_account: alice
seq_num: 103720918407356415
fee: 100
time_bounds:
  min_time: 1735689600
  max_time: 1893456000
memo:
  type: none
operations:
  - type: payment
    destination: bob
    asset: { type: native }
    amount: "125.5000000"
signers:
  - alice
expect: valid
```
