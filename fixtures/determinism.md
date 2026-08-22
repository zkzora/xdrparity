# XDRParity Determinism Rules

Every conforming runner, given the same fixture, must produce **byte-identical
XDR on every run, on every machine**. These rules are what make that possible.
A runner that violates any rule in this document is nonconforming: its output
is triaged as a *runner-bug*, never as an SDK divergence.

## 1. Network

- Passphrase (exact string — one space on each side of the semicolon):

  ```
  Test SDF Network ; September 2015
  ```

- Network ID (SHA-256 of the passphrase, committed here as a constant so the
  harness can cross-check signature payload hashes):

  ```
  cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472
  ```

## 2. No network I/O — ever

**A runner that performs any network I/O is nonconforming.** No Horizon, no
Soroban RPC, no friendbot, no simulation, no fetching sequence numbers, no DNS
lookups of any kind. Everything a runner needs arrives in its stdin JSON
(see `runners/contract.md`). The accounts and contracts referenced by fixtures
do not need to exist on any network — XDRParity builds and signs transactions
entirely offline.

## 3. Test keypairs

> **TESTNET-ONLY — NEVER FUND.** These seeds are committed to this repository
> on purpose: they are shared test vectors, and anyone on the internet can
> spend from them. They must never hold value or be used on any network,
> including testnet. Funding them defeats their purpose and loses the funds.

Generated once with stellar CLI 27.0.0 (`stellar keys generate --as-secret`)
on 2026-08-22 and committed forever. They are never regenerated — fixture
outputs are only comparable across time because these bytes never change.

| label | public key | secret seed |
|-------|------------|-------------|
| alice | `GDVTHGAKUSGSMVXGLSU5LIR3VBYE36MKGW443HBARQIAPE6SEZGHEJLC` | `SCNNJVGY4WCY3QCMJB4S3M2CJVUXCT5Y6VHT7VC3LUXSYG363SBMCOPA` |
| bob   | `GD736ZDG6TG24DDM4G42K3DKUJKDEOAD5ECAJHRGE5YWN2N2SWIPW53D` | `SDKHAS3IFPV6TUXY7WFV6Y5PSDDQTXDXXUICEM62CRI3RG77IZL5S6RS` |
| carol | `GAJ7AQWPOQRZHLQ75OZMT4FW67OGAQJY5XLVX2INNKTHBIQTBRFVZHTQ` | `SC27X3EQOLQSV2KPIQUIVCEDEWM4JSQGTACON4N4OFE6UK73GKFMUVSL` |
| dave  | `GC6E7NBPJYA3LRHB6WTKBRJXX7LYKUEY56TMSTNYBKFGUYQX65NUNVD5` | `SCSDNPY3IA5MH7YIOC2QZD5WZWJLMSLYTVVNBGZ7TREI4LIZDRS2Y6BK` |

(`dave` is reserved — no current fixture references it; committed now so the
set never changes.)

Fixtures refer to keypairs **by label**. The harness resolves labels to seeds
and passes the seeds in the runner input JSON — runners never read this file
and never hold their own key material.

## 4. Sequence numbers

- Every fixture commits a **fixed int64 literal** as `seq_num`
  (e.g. `103720918407356415`). It is defined in the fixture, never fetched.
- The fixture value **is the sequence number that must appear in the built
  envelope's `seqNum` field**. SDKs whose transaction builder takes the
  account's *current* sequence and auto-increments must be fed
  `seq_num - 1`. Getting this off by one is a runner-bug.
- Committed values are always ≥ 1, so `seq_num - 1` is always a valid
  current sequence.
- JSON transport rule: `seq_num` always travels as a **decimal string** —
  int64 values exceed the IEEE-754 safe-integer range and would silently
  corrupt in JavaScript.

## 5. Time bounds

- **Absolute unix timestamps, committed in the fixture.** Never `now()`,
  never relative offsets, never library defaults.
- Committed bounds always satisfy `1 ≤ min_time ≤ max_time`. The value `0`
  is never committed — the protocol treats it as "unbounded", which is a
  different transaction than a bounded one.
- Every valid fixture sets both bounds explicitly. The built envelope's
  preconditions must therefore be exactly a time-bounds precondition
  (`PRECOND_TIME`) — not `PRECOND_NONE`, and not a `PRECOND_V2` wrapper,
  unless a future fixture explicitly commits other preconditions.
- Canonical values used by most fixtures (any fixture may commit others, but
  always as literals):
  - `min_time` = `1735689600` (2025-01-01T00:00:00Z)
  - `max_time` = `1893456000` (2030-01-01T00:00:00Z)

## 6. Fees

Every fixture commits a fixed `fee` literal (uint32). It is the **total fee
that must appear in the built envelope's `fee` field**, exactly. Beware:
every mainstream SDK builder takes a *per-operation base fee* and multiplies
by the operation count — runners using such builders must feed
`fee / operation_count`. Fixtures guarantee `fee` is divisible by their
operation count. An envelope fee of `fee × N` is a runner-bug.

## 7. Signing

- The fixture's `signers[]` order is the **exact order** of the signature
  list in the envelope. Signature 0 is the first listed signer.
- Signatures are ed25519 over the standard `TransactionSignaturePayload`
  hash (defined precisely in `runners/contract.md`).
- Ed25519 signing is deterministic (RFC 8032): same transaction plus same
  seed must yield the same signature bytes in every SDK. A runner producing
  nondeterministic signatures is nonconforming.
- Runners sign via the SDK's standard transaction-sign API. Each signature
  is a `DecoratedSignature` whose hint is the last 4 bytes of the signer's
  ed25519 public key. Hand-rolled signing or decoration is nonconforming.

## 8. Soroban fixtures

Soroban transactions are built **without simulation** (rule 2):

- Contract IDs are fixed, well-formed `C...` addresses committed as fixture
  constants. The contracts do not need to exist anywhere.
- All ScVal arguments are committed literals (`fixtures/schema.md` defines
  the notation).
- All authorization entries are committed in the fixture, including nonces
  and signature-expiration ledger numbers as fixed literals.
- Soroban transaction data / resource fees are omitted (transaction `ext` is
  left empty) unless a fixture explicitly commits them. These transactions
  would not succeed on-chain — that is fine; XDRParity measures *building and
  signing* parity, not execution.

## 9. The determinism gate

Running the full fixture × SDK matrix twice must produce **byte-identical**
raw outputs. This will be enforced by `npm run verify-determinism` (Fase 6):
any nondeterminism anywhere in the pipeline is a failure, no exceptions.
