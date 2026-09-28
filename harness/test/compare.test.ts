// Comparator unit tests (Fase 5–6), including a synthetic divergent envelope
// built by mutating the committed sample through the neutral CLI, and the
// runner-bug isolation rules (contract violations are never SDK divergence).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareRaw, deepDiff, dimensionForPath, recomputeSigPayloadHash, splitByTriage, type Mismatch } from '../src/compare.ts';
import { decodeEnvelope, encodeEnvelope } from '../src/normalize.ts';

const sampleXdr = readFileSync(join(import.meta.dirname, 'fixtures', 'f001-envelope.xdr'), 'utf8').trim();
// The JS reference runner's f001 sig_payload_hash — committed test literal.
const sampleHash = '1518744e18fd821554b64f7f315be612e2b63f36aed19d3736059c091084501b';

const goodCell = { tx_xdr: sampleXdr, sig_payload_hash: sampleHash, error: null };
const violationCell = { contract_violation: 'runner exited 137', stderr_tail: '...' };

function mutatedEnvelope(): string {
  const decoded = decodeEnvelope(sampleXdr) as { tx: { tx: { fee: number } } };
  decoded.tx.tx.fee += 1;
  return encodeEnvelope(JSON.stringify(decoded));
}

describe('deepDiff', () => {
  it('finds nothing on identical values', () => {
    expect(deepDiff({ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] })).toEqual([]);
  });
  it('reports path, both values, and absences', () => {
    const diffs = deepDiff({ a: 1, c: 3 }, { a: 2, b: 9 });
    expect(diffs).toContainEqual({ path: '$.a', a: 1, b: 2 });
    expect(diffs).toContainEqual({ path: '$.b', a: '<absent>', b: 9 });
    expect(diffs).toContainEqual({ path: '$.c', a: 3, b: '<absent>' });
  });
});

describe('dimensionForPath', () => {
  it('labels Soroban auth-subtree diffs as dimension 2', () => {
    expect(dimensionForPath('$.tx.tx.operations[0].body.invoke_host_function.auth[1].credentials')).toBe(2);
    expect(dimensionForPath('$.tx.tx.operations[0].body.invoke_host_function.auth.length')).toBe(2);
  });
  it('keeps classic allow_trust.authorize (and everything else) in dimension 1', () => {
    expect(dimensionForPath('$.tx.tx.operations[0].body.allow_trust.authorize')).toBe(1);
    expect(dimensionForPath('$.tx.tx.fee')).toBe(1);
    expect(dimensionForPath('$.tx.tx.operations[0].body.invoke_host_function.host_function')).toBe(1);
  });
});

// f017: Soroban invocation whose auth entry uses the protocol-27+
// SOROBAN_CREDENTIALS_ADDRESS_V2 arm — committed test data.
const v2Xdr = readFileSync(join(import.meta.dirname, 'fixtures', 'f017-envelope.xdr'), 'utf8').trim();
const v2Hash = '29382012975decf97cef24b762082b1e39e780531a9bf9457ca98a79b4f7d87a';

describe('invariant 6', () => {
  it('recomputes the sample hash from the decoded envelope + network id', () => {
    expect(recomputeSigPayloadHash(decodeEnvelope(sampleXdr))).toBe(sampleHash);
  });
  it('recomputes the hash of a Soroban envelope carrying ADDRESS_V2 auth credentials', () => {
    expect(recomputeSigPayloadHash(decodeEnvelope(v2Xdr))).toBe(v2Hash);
  });
});

describe('auth credential arm divergence', () => {
  it('a legacy-vs-V2 credentials arm mismatch is named as dimension 2, not buried in dimension 1', () => {
    type Env = { tx: { tx: { operations: Array<{ body: { invoke_host_function: { auth: Array<{ credentials: Record<string, unknown> }> } } }> } } };
    const legacy = decodeEnvelope(v2Xdr) as Env;
    const cred = legacy.tx.tx.operations[0].body.invoke_host_function.auth[0].credentials;
    cred.address = cred.address_v2; // same struct, legacy discriminant
    delete cred.address_v2;
    const legacyXdr = encodeEnvelope(JSON.stringify(legacy));
    const legacyCell = { tx_xdr: legacyXdr, sig_payload_hash: recomputeSigPayloadHash(legacy), error: null };

    const { mismatches, runnerBugs } = compareRaw({
      f017: { a: { tx_xdr: v2Xdr, sig_payload_hash: v2Hash, error: null }, b: legacyCell },
    });
    expect(runnerBugs).toEqual([]); // both cells self-report honestly
    const structural = mismatches.filter((m) => m.dimension === 1 || m.dimension === 2);
    expect(structural.length).toBeGreaterThan(0);
    expect(structural.every((m) => m.dimension === 2)).toBe(true);
    expect(structural.map((m) => m.path)).toContain(
      '$.tx.tx.operations[0].body.invoke_host_function.auth[0].credentials.address_v2');
    expect(mismatches).toContainEqual(expect.objectContaining({ dimension: 3 })); // the arm changes the signed bytes
  });
});

describe('compareRaw', () => {
  it('is clean when both SDKs return identical envelopes', () => {
    expect(compareRaw({ f001: { a: { ...goodCell }, b: { ...goodCell } } }))
      .toEqual({ mismatches: [], runnerBugs: [] });
  });

  it('flags a synthetic divergent envelope on dims 1 and 3, and a wrong self-report as a runner bug', () => {
    const divergent = {
      tx_xdr: mutatedEnvelope(),
      sig_payload_hash: '0'.repeat(64), // deliberately wrong self-report
      error: null,
    };
    const { mismatches, runnerBugs } = compareRaw({ f001: { a: { ...goodCell }, b: divergent } });
    const dims = mismatches.map((m) => `${m.dimension}:${m.pair}`);
    expect(dims).toContain('1:a↔b');  // structural fee diff
    expect(dims).toContain('3:a↔b');  // hash inequality
    expect(mismatches.filter((m) => m.dimension === 4)).toEqual([]); // both round-trip fine
    expect(mismatches.find((m) => m.dimension === 1)?.path).toContain('fee');
    // Invariant 6 failure is a runner bug for b only — never an SDK divergence.
    expect(runnerBugs).toEqual([expect.objectContaining({ fixture: 'f001', sdk: 'b' })]);
    expect(runnerBugs[0].reason).toContain('invariant 6');
  });

  it('reports a valid-fixture cell with a structured refusal as its own dim-1 problem', () => {
    const errCell = { tx_xdr: null, sig_payload_hash: null, error: { stage: 'build', message: 'x' } };
    const { mismatches } = compareRaw({ f009: { a: { ...goodCell }, b: errCell } });
    expect(mismatches).toContainEqual(expect.objectContaining({ fixture: 'f009', dimension: 1, pair: 'b' }));
  });

  it('isolates contract violations as runner bugs, excluded from every comparison', () => {
    // Valid fixture: the violating cell must not appear in mismatches at all.
    const valid = compareRaw({ f001: { a: { ...goodCell }, b: { ...violationCell } } });
    expect(valid.mismatches).toEqual([]);
    expect(valid.runnerBugs).toEqual([
      { fixture: 'f001', sdk: 'b', reason: 'runner exited 137' },
    ]);
    // Invalid fixture: no dim-5 pairing against the violating cell either.
    const parseCell = { tx_xdr: null, sig_payload_hash: null, error: { stage: 'parse', message: 'x' } };
    const invalid = compareRaw({ e001: { a: parseCell, b: { ...violationCell }, c: parseCell } });
    expect(invalid.mismatches).toEqual([]); // a↔c agree; b is out of the comparison
    expect(invalid.runnerBugs).toEqual([
      { fixture: 'e001', sdk: 'b', reason: 'runner exited 137' },
    ]);
  });

  it('dimension 5: compares rejection stage on invalid fixtures, never the message', () => {
    const parseCell = { tx_xdr: null, sig_payload_hash: null, error: { stage: 'parse', message: 'wording A' } };
    const parseCell2 = { tx_xdr: null, sig_payload_hash: null, error: { stage: 'parse', message: 'totally different wording' } };
    const buildCell = { tx_xdr: null, sig_payload_hash: null, error: { stage: 'build', message: 'x' } };
    expect(compareRaw({ e001: { a: parseCell, b: parseCell2 } }).mismatches).toEqual([]); // same stage, message ignored
    expect(compareRaw({ e001: { a: parseCell, b: buildCell } }).mismatches).toEqual([
      expect.objectContaining({
        dimension: 5, pair: 'a↔b', a: 'rejected at parse', b: 'rejected at build',
      }),
    ]);
    // An SDK that ACCEPTS an invalid fixture mismatches both against the
    // expectation baseline and pairwise.
    const accepted = compareRaw({ e001: { a: parseCell, b: { ...goodCell } } }).mismatches;
    expect(accepted).toContainEqual(expect.objectContaining({
      dimension: 5, pair: 'b', path: 'expect', a: 'accepted',
    }));
    expect(accepted).toContainEqual(expect.objectContaining({
      dimension: 5, pair: 'a↔b', a: 'rejected at parse', b: 'accepted',
    }));
  });

  it('uniform acceptance of an invalid fixture is still flagged (pairwise agreement must not hide it)', () => {
    const { mismatches } = compareRaw({ e002: { a: { ...goodCell }, b: { ...goodCell } } });
    expect(mismatches).toContainEqual(expect.objectContaining({ dimension: 5, pair: 'a', a: 'accepted' }));
    expect(mismatches).toContainEqual(expect.objectContaining({ dimension: 5, pair: 'b', a: 'accepted' }));
  });

  it('an envelope the neutral CLI cannot decode is a runner bug, and never crashes the comparator', () => {
    const badCell = { tx_xdr: '!!!not-xdr!!!', sig_payload_hash: '0'.repeat(64), error: null };
    const { mismatches, runnerBugs } = compareRaw({ f001: { a: { ...goodCell }, b: badCell } });
    expect(runnerBugs).toEqual([expect.objectContaining({ fixture: 'f001', sdk: 'b' })]);
    expect(runnerBugs[0].reason).toContain('undecodable');
    expect(mismatches).toEqual([]); // a alone has nothing to pair against
  });
});

describe('splitByTriage', () => {
  const mismatch: Mismatch = { fixture: 'f001', dimension: 3, pair: 'a↔b', path: 'sig_payload_hash', a: 'x', b: 'y' };
  const entry = { fixture: 'f001', dimension: 3 as const, pair: 'a↔b', path: 'sig_payload_hash', label: 'runner-bug' as const, note: 'n' };
  it('separates triaged from pending by fixture+dimension+pair+path', () => {
    expect(splitByTriage([mismatch], [entry])).toEqual({ triaged: [{ mismatch, entry }], pending: [] });
    expect(splitByTriage([mismatch], [])).toEqual({ triaged: [], pending: [mismatch] });
  });
  it('one triage entry never blankets a different path in the same cell-pair', () => {
    const otherPath: Mismatch = { ...mismatch, path: '$.tx.tx.fee' };
    expect(splitByTriage([mismatch, otherPath], [entry]))
      .toEqual({ triaged: [{ mismatch, entry }], pending: [otherPath] });
  });
});
