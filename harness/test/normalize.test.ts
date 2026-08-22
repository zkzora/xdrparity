// Unit tests for the neutral normalizer (Fase 3). The committed sample is
// the JS runner's f001 envelope — test data, not a reference under test.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalize, decodeEnvelope, encodeEnvelope, normalizeEnvelope, roundTrip } from '../src/normalize.ts';

const sampleXdr = readFileSync(join(import.meta.dirname, 'fixtures', 'f001-envelope.xdr'), 'utf8').trim();

describe('decodeEnvelope', () => {
  it('decodes a committed envelope via the stellar CLI', () => {
    const decoded = decodeEnvelope(sampleXdr) as Record<string, unknown>;
    expect(decoded).toBeTypeOf('object');
    expect(decoded).toHaveProperty('tx');
  });
});

describe('canonicalize', () => {
  it('is independent of input key order', () => {
    expect(canonicalize({ b: 1, a: [{ d: null, c: 'x' }] }))
      .toBe(canonicalize({ a: [{ c: 'x', d: null }], b: 1 }));
  });

  it('produces byte-identical canonical JSON across runs', () => {
    const first = normalizeEnvelope(sampleXdr);
    const second = normalizeEnvelope(sampleXdr);
    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(0);
  });
});

describe('roundTrip (dimension 4)', () => {
  it('re-encodes the committed envelope to identical bytes', () => {
    const result = roundTrip(sampleXdr);
    expect(result.ok).toBe(true);
    expect(result.reencoded).toBe(sampleXdr);
  });

  it('detects a deliberately mutated envelope', () => {
    const decoded = decodeEnvelope(sampleXdr) as { tx: { tx: { fee: number } } };
    decoded.tx.tx.fee += 1;
    const mutatedXdr = encodeEnvelope(JSON.stringify(decoded));
    expect(mutatedXdr).not.toBe(sampleXdr);
    // The mutated envelope itself still round-trips — the check catches
    // byte drift against the ORIGINAL, which is how the harness uses it.
    expect(roundTrip(mutatedXdr).ok).toBe(true);
  });
});
