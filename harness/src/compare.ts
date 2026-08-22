// XDRParity comparator — all five dimensions (CLAUDE.md):
//   1  operation/envelope structure   (deep diff of canonical decoded JSON)
//   2  Soroban auth entries           (same walk, auth-subtree diffs labeled dim 2)
//   3  sig_payload_hash equality      (pairwise string equality)
//   4  XDR round-trip stability       (decode → re-encode via official CLI → identical bytes)
//   5  error behavior on invalid/     (rejected? at which stage? message never compared)
//
// Runner bugs are OUR bugs and are never reported as SDK divergence:
//   - contract violations (nonzero exit, malformed stdout) become runner-bug
//     cells and are excluded from every pairwise comparison;
//   - invariant-6 failures (self-reported sig_payload_hash ≠ the harness's
//     recomputation from the decoded envelope + network id) are runner bugs.
//
// Mismatches are printed, never auto-resolved. Triage decisions live in
// harness/rules/triage.json as committed data; anything untriaged is PENDING.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NETWORK_ID_HEX } from './determinism.ts';
import { decodeEnvelopeRaw, encodeEnvelope, encodeType } from './normalize.ts';

const ROOT = join(import.meta.dirname, '..', '..');

export type Dimension = 1 | 2 | 3 | 4 | 5;

export interface Mismatch {
  fixture: string;
  dimension: Dimension;
  pair: string; // "a↔b" for cross-SDK dimensions, a single sdk for dim 4 / no-envelope cells
  path: string;
  a: unknown;
  b: unknown;
}

export interface RunnerBug {
  fixture: string;
  sdk: string;
  reason: string;
}

export interface CompareResult {
  mismatches: Mismatch[];
  runnerBugs: RunnerBug[];
}

export interface TriageEntry {
  fixture: string;
  dimension: Dimension;
  pair: string;
  path: string; // exact JSON path — one entry never blankets other paths in the same cell-pair
  label: 'confirmed-divergence' | 'normalization-gap' | 'runner-bug';
  note: string;
}

interface Diff {
  path: string;
  a: unknown;
  b: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export function deepDiff(a: unknown, b: unknown, path = '$', out: Diff[] = []): Diff[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push({ path: `${path}.length`, a: a.length, b: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) deepDiff(a[i], b[i], `${path}[${i}]`, out);
  } else if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!(k in a)) out.push({ path: `${path}.${k}`, a: '<absent>', b: b[k] });
      else if (!(k in b)) out.push({ path: `${path}.${k}`, a: a[k], b: '<absent>' });
      else deepDiff(a[k], b[k], `${path}.${k}`, out);
    }
  } else if (a !== b) {
    out.push({ path, a, b });
  }
  return out;
}

/**
 * Auth-entry divergence is its own dimension, not buried in the structural
 * diff. Anchored to the Soroban op's auth array specifically — a bare
 * '.auth' substring test would also catch classic allow_trust's "authorize"
 * field.
 */
export const dimensionForPath = (path: string): 1 | 2 =>
  /\.invoke_host_function\.auth(\[|\.|$)/.test(path) ? 2 : 1;

/** Invariant 6: sha256(network id ‖ ENVELOPE_TYPE_TX ‖ Transaction XDR), via the neutral CLI only. */
export function recomputeSigPayloadHash(decodedEnvelope: unknown): string {
  const txJson = (decodedEnvelope as { tx: { tx: unknown } }).tx.tx;
  const txBytes = Buffer.from(encodeType('Transaction', JSON.stringify(txJson)), 'base64');
  const envelopeTypeTx = Buffer.from([0, 0, 0, 2]);
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(NETWORK_ID_HEX, 'hex'), envelopeTypeTx, txBytes]))
    .digest('hex');
}

type Cell = Record<string, unknown>;
type Raw = Record<string, Record<string, Cell>>;

export function compareRaw(raw: Raw): CompareResult {
  const mismatches: Mismatch[] = [];
  const runnerBugs: RunnerBug[] = [];
  for (const fixture of Object.keys(raw).sort()) {
    const cells = raw[fixture];
    // Contract violations are runner bugs, excluded from every comparison.
    const sdks = Object.keys(cells).sort().filter((sdk) => {
      if (cells[sdk].contract_violation) {
        runnerBugs.push({ fixture, sdk, reason: String(cells[sdk].contract_violation) });
        return false;
      }
      return true;
    });

    if (!fixture.startsWith('f')) {
      // Dimension 5: invalid fixtures — did the SDK reject, and at which stage?
      const behavior = (sdk: string): string => {
        const cell = cells[sdk];
        if (typeof cell.tx_xdr === 'string') return 'accepted';
        const err = cell.error as { stage?: string } | null;
        return `rejected at ${err?.stage ?? 'unknown'}`;
      };
      // Baseline check first: accepting an invalid fixture is always a
      // mismatch, even when every SDK accepts it uniformly (pairwise
      // agreement must not hide it).
      for (const sdk of sdks) {
        if (behavior(sdk) === 'accepted') {
          mismatches.push({
            fixture, dimension: 5, pair: sdk, path: 'expect',
            a: 'accepted', b: 'rejection expected (expect: error)',
          });
        }
      }
      for (let i = 0; i < sdks.length; i++) {
        for (let j = i + 1; j < sdks.length; j++) {
          const [a, b] = [behavior(sdks[i]), behavior(sdks[j])];
          if (a !== b) {
            mismatches.push({
              fixture, dimension: 5, pair: `${sdks[i]}↔${sdks[j]}`, path: 'error.stage', a, b,
            });
          }
        }
      }
      continue;
    }

    // Valid fixtures: decode once per cell, then dims 1/2/3/4 + invariant 6.
    const decoded: Record<string, unknown> = {};
    for (const sdk of sdks) {
      const cell = cells[sdk];
      if (typeof cell.tx_xdr !== 'string') {
        // A structured refusal of a valid fixture is SDK behavior, not a runner bug.
        mismatches.push({
          fixture, dimension: 1, pair: sdk, path: '$',
          a: 'no envelope produced', b: cell.error,
        });
        continue;
      }
      let rawJson: string;
      let parsed: { tx?: { tx?: unknown } };
      try {
        rawJson = decodeEnvelopeRaw(cell.tx_xdr);
        parsed = JSON.parse(rawJson);
      } catch (e) {
        // XDR the official CLI cannot decode: a contract breach, and one bad
        // cell must never take down the whole report.
        runnerBugs.push({ fixture, sdk, reason: `envelope undecodable by the stellar CLI: ${String(e).slice(0, 200)}` });
        continue;
      }
      if (parsed.tx?.tx === undefined) {
        // Contract requires ENVELOPE_TYPE_TX; a v0 or fee-bump envelope is a runner bug.
        runnerBugs.push({ fixture, sdk, reason: `not an ENVELOPE_TYPE_TX envelope (top-level key: ${Object.keys(parsed)[0]})` });
        continue;
      }
      decoded[sdk] = parsed;
      // Dimension 4: round-trip byte stability through the official CLI.
      const reencoded = encodeEnvelope(rawJson);
      if (reencoded !== cell.tx_xdr) {
        mismatches.push({
          fixture, dimension: 4, pair: sdk, path: 'tx_xdr',
          a: cell.tx_xdr, b: reencoded,
        });
      }
      // Invariant 6: self-reported hash must equal the harness's recomputation.
      const recomputed = recomputeSigPayloadHash(parsed);
      if (recomputed !== cell.sig_payload_hash) {
        runnerBugs.push({
          fixture, sdk,
          reason: `invariant 6: self-reported sig_payload_hash ${cell.sig_payload_hash} != recomputed ${recomputed}`,
        });
      }
    }
    const ok = sdks.filter((s) => s in decoded);
    for (let i = 0; i < ok.length; i++) {
      for (let j = i + 1; j < ok.length; j++) {
        const [a, b] = [ok[i], ok[j]];
        for (const d of deepDiff(decoded[a], decoded[b])) {
          mismatches.push({
            fixture, dimension: dimensionForPath(d.path), pair: `${a}↔${b}`,
            path: d.path, a: d.a, b: d.b,
          });
        }
        if (cells[a].sig_payload_hash !== cells[b].sig_payload_hash) {
          mismatches.push({
            fixture, dimension: 3, pair: `${a}↔${b}`, path: 'sig_payload_hash',
            a: cells[a].sig_payload_hash, b: cells[b].sig_payload_hash,
          });
        }
      }
    }
  }
  return { mismatches, runnerBugs };
}

export function loadTriage(): TriageEntry[] {
  const path = join(ROOT, 'harness', 'rules', 'triage.json');
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: TriageEntry[] }).entries;
}

export function splitByTriage(mismatches: Mismatch[], triage: TriageEntry[]) {
  const key = (m: { fixture: string; dimension: Dimension; pair: string; path: string }) =>
    `${m.fixture}|${m.dimension}|${m.pair}|${m.path}`;
  const byKey = new Map(triage.map((t) => [key(t), t]));
  const triaged: Array<{ mismatch: Mismatch; entry: TriageEntry }> = [];
  const pending: Mismatch[] = [];
  for (const m of mismatches) {
    const entry = byKey.get(key(m));
    if (entry) triaged.push({ mismatch: m, entry });
    else pending.push(m);
  }
  return { triaged, pending };
}

const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s !== undefined && s.length > 120 ? `${s.slice(0, 117)}...` : s;
};

function main() {
  const raw = JSON.parse(readFileSync(join(ROOT, 'report', 'raw.json'), 'utf8')) as Raw;
  const { mismatches, runnerBugs } = compareRaw(raw);
  const { triaged, pending } = splitByTriage(mismatches, loadTriage());

  if (runnerBugs.length > 0) {
    console.log(`--- ${runnerBugs.length} runner-bug cell(s) — OUR bugs, never SDK divergence ---`);
    for (const b of runnerBugs) console.log(`${b.fixture}  ${b.sdk}  ${b.reason}`);
    console.log('');
    process.exitCode = 2;
  }
  if (mismatches.length === 0) {
    if (runnerBugs.length === 0) {
      console.log('comparator: no mismatches across all five dimensions (and invariant 6 holds for every cell)');
    }
    return;
  }
  for (const { mismatch: m, entry } of triaged) {
    console.log(`${m.fixture}  dim${m.dimension}  ${m.pair}  [${entry.label}] ${entry.note}`);
    console.log(`  path: ${m.path}\n  a: ${show(m.a)}\n  b: ${show(m.b)}\n`);
  }
  if (pending.length > 0) {
    console.log(`--- ${pending.length} mismatch(es) PENDING human triage ---\n`);
    for (const m of pending) {
      console.log(`${m.fixture}  dim${m.dimension}  ${m.pair}  [PENDING]`);
      console.log(`  path: ${m.path}\n  a: ${show(m.a)}\n  b: ${show(m.b)}\n`);
    }
    process.exitCode = 3; // pending mismatches — not a crash
  } else {
    console.log(`comparator: ${mismatches.length} mismatch(es), all triaged; nothing pending`);
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('compare.ts');
if (invokedDirectly) main();
