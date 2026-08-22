// XDRParity neutral normalizer (CLAUDE.md invariants 2 and 5).
// All XDR decoding/encoding goes through the official Rust `stellar` CLI —
// never through any SDK under test.
//
// Normalization rules: NONE yet, by design. Canonicalization is stable key
// ordering and nothing else. A rule may only be added when a real mismatch
// proves it is needed, and it must land in harness/rules/normalization.md
// with rationale in the same commit.
import { spawnSync } from 'node:child_process';

function stellarXdr(args: string[], input: string): string {
  const proc = spawnSync('stellar', ['xdr', ...args], {
    input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    throw new Error(`stellar xdr ${args.join(' ')} failed (exit ${proc.status}): ${proc.stderr.trim()}`);
  }
  return proc.stdout.trim();
}

/** Decode a base64 TransactionEnvelope to the CLI's raw JSON text (one line). */
export function decodeEnvelopeRaw(xdrBase64: string): string {
  return stellarXdr(['decode', '--type', 'TransactionEnvelope', '--output', 'json'], xdrBase64.trim());
}

/** Decode a base64 TransactionEnvelope to a JSON value. */
export function decodeEnvelope(xdrBase64: string): unknown {
  return JSON.parse(decodeEnvelopeRaw(xdrBase64));
}

/** Re-encode the CLI's decoded JSON back to base64 XDR. */
export function encodeEnvelope(json: string): string {
  return stellarXdr(['encode', '--type', 'TransactionEnvelope'], json);
}

/** Encode any XDR type's JSON to base64 via the neutral CLI (e.g. Transaction, for invariant 6). */
export function encodeType(type: string, json: string): string {
  return stellarXdr(['encode', '--type', type], json);
}

/**
 * Canonical JSON: objects with keys sorted lexicographically, arrays in
 * order, no whitespace. This is the comparator's input format (dimension 1).
 */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as object).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Decode + canonicalize in one step. */
export function normalizeEnvelope(xdrBase64: string): string {
  return canonicalize(decodeEnvelope(xdrBase64));
}

export interface RoundTripResult {
  ok: boolean;
  reencoded: string;
}

/**
 * Dimension 4: decode → re-encode via the official CLI → the bytes must be
 * identical to the runner's original XDR. (Base64 comparison is byte
 * comparison: both sides are single-line RFC 4648 §4 with padding.)
 */
export function roundTrip(xdrBase64: string): RoundTripResult {
  const original = xdrBase64.trim();
  const reencoded = encodeEnvelope(decodeEnvelopeRaw(original));
  return { ok: reencoded === original, reencoded };
}
