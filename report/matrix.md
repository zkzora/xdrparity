# XDRParity Conformance Matrix

Generated: 2026-09-28T10:16:29.633Z • Protocol version: 28 • Fixtures: 20 valid + 5 invalid • SDKs: 4

| SDK | package | pinned version |
|---|---|---|
| go | github.com/stellar/go-stellar-sdk (txnbuild) | `v0.7.3` |
| java | network.lightsail:stellar-sdk (java-stellar-sdk) | `5.0.0` |
| js | @stellar/stellar-sdk | `17.1.0` |
| python | stellar-sdk (PyPI) | `16.1.0` |

Reference decoder (neutral — never an SDK under test): `stellar 28.1.0` · `stellar-xdr 28.0.0` · `XDR definitions 9c9c145953e8`

Legend: `PASS` — all five dimensions agree · `FAIL dN` — worst failing dimension (3 sig-payload-hash > 2 soroban-auth > 1 structure > 4 round-trip > 5 error-stage) · `RUNNER-BUG` — contract violation or invariant-6 failure, our bug, never SDK divergence. Failing cells link to the diff details below.

| fixture | title | go | java | js | python |
|---|---|---|---|---|---|
| e001 | malformed asset code: 13 characters | PASS | PASS | PASS | PASS |
| e002 | seq_num is string garbage | PASS | PASS | PASS | PASS |
| e003 | unknown operation type | PASS | PASS | PASS | PASS |
| e004 | destination address with bad checksum | PASS | PASS | PASS | PASS |
| e005 | i128 out of range (2^127) | PASS | PASS | PASS | PASS |
| f001 | native payment, alice pays bob | PASS | PASS | PASS | PASS |
| f002 | issued-asset payment, USDC issued by bob, alice pays carol | PASS | PASS | PASS | PASS |
| f003 | native payment with UTF-8 text memo | PASS | PASS | PASS | PASS |
| f004 | native payment to muxed destination (bob, id 9876543210) | PASS | PASS | PASS | PASS |
| f005 | create_account, alice creates carol | PASS | PASS | PASS | PASS |
| f006 | change_trust, alice trusts USDC (bob) with explicit limit | PASS | PASS | PASS | PASS |
| f007 | change_trust, limit zero deletes the trustline | PASS | PASS | PASS | PASS |
| f008 | set_options, add carol as an ed25519 signer | PASS | PASS | PASS | PASS |
| f009 | set_options thresholds; two signatures in committed order | PASS | PASS | PASS | PASS |
| f010 | set_options, home domain | PASS | PASS | PASS | PASS |
| f011 | set_options master weight; three signatures in committed order | PASS | PASS | PASS | PASS |
| f012 | create_claimable_balance, native, unconditional claimant | PASS | PASS | PASS | PASS |
| f013 | create_claimable_balance, issued asset, time predicate | PASS | PASS | PASS | PASS |
| f014 | invoke_contract, token transfer args | PASS | PASS | PASS | PASS |
| f015 | invoke_contract, multi-arg call: u32/i128/symbol/address/vec | PASS | PASS | PASS | PASS |
| f016 | invoke_contract with two auth entries (source-account + legacy address) | PASS | PASS | PASS | PASS |
| f017 | invoke_contract with nested invocation auth tree, address-bound V2 credentials | PASS | PASS | PASS | PASS |
| f018 | invoke_contract, i128 boundary values (max and min) | PASS | PASS | PASS | PASS |
| f019 | invoke_contract, edge scalars: 32-char symbol, u32 max, void | PASS | PASS | PASS | PASS |
| f020 | invoke_contract, empty vec and nested vec-of-vec | PASS | PASS | PASS | PASS |

## Mismatch details

None. Every cell agrees on every dimension, and invariant 6 holds for every cell.

## Confirmed divergences

None so far — across the full matrix, all four SDKs produce byte-identical envelopes on every valid fixture and agree on every rejection stage.
