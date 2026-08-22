// XDRParity harness — execute runners over fixtures.
//   npm run one -- --sdk js --fixture f001     one cell, print runner stdout
//   npm run matrix                             matrix.ts: all SDKs × fixtures → report/ (see matrix.ts)
// Converts fixture YAML → runner input JSON (fixtures/schema.md, "YAML →
// runner JSON") and executes runners per runners/versions.json.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { KEYPAIRS, NETWORK_PASSPHRASE } from './determinism.ts';

const ROOT = join(import.meta.dirname, '..', '..');

// Keys whose string values are account references (fixtures/schema.md,
// "Account references"): a keypair label resolves to its public key,
// anything else passes through verbatim.
const ACCOUNT_REF_KEYS = new Set(['source_account', 'destination', 'issuer', 'source', 'key', 'address']);

// BigInt-safe deep transform: resolve labels, convert YAML big ints.
function toJson(value: unknown, parentKey?: string): unknown {
  if (typeof value === 'bigint') {
    return value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER
      ? Number(value) : value.toString();
  }
  if (Array.isArray(value)) return value.map((v) => toJson(v));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v, k)]));
  }
  if (typeof value === 'string' && parentKey !== undefined
      && ACCOUNT_REF_KEYS.has(parentKey) && KEYPAIRS[value]) {
    return KEYPAIRS[value].publicKey;
  }
  return value;
}

export function loadFixture(id: string): Record<string, unknown> {
  for (const dir of ['valid', 'invalid']) {
    const path = join(ROOT, 'fixtures', dir, `${id}.yaml`);
    if (existsSync(path)) return parse(readFileSync(path, 'utf8'), { intAsBigInt: true });
  }
  throw new Error(`fixture not found: ${id}`);
}

export function toRunnerInput(fixture: Record<string, unknown>): string {
  const fx = toJson(fixture) as Record<string, unknown>;
  const signers = (fx.signers as string[]).map((label) => {
    const kp = KEYPAIRS[label];
    if (!kp) throw new Error(`unknown signer label: ${label}`);
    return { label, secret_seed: kp.secretSeed };
  });
  return JSON.stringify({
    fixture_id: fx.id,
    network_passphrase: NETWORK_PASSPHRASE,
    tx: {
      source_account: fx.source_account,
      // seq_num travels as a decimal string (contract.md); invalid fixtures
      // may commit garbage — passed through verbatim, never validated here.
      seq_num: String(fx.seq_num),
      fee: fx.fee,
      time_bounds: fx.time_bounds,
      memo: fx.memo,
      operations: fx.operations,
    },
    signers,
  });
}

export interface RunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export function runRunner(sdk: string, input: string): RunnerResult {
  const versions = JSON.parse(readFileSync(join(ROOT, 'runners', 'versions.json'), 'utf8'));
  const entry = versions[sdk];
  if (!entry) throw new Error(`unknown sdk '${sdk}' — not in runners/versions.json`);
  // ${VAR} tokens in run commands expand from the environment (e.g. a runner
  // that must use JAVA_HOME's java rather than whatever is first on PATH).
  const expand = (s: string) =>
    s.replace(/\$\{(\w+)\}/g, (_, name) => {
      const v = process.env[name];
      if (v === undefined) throw new Error(`versions.json run command needs env var ${name}, which is unset`);
      return v;
    });
  const [cmd, ...args] = (entry.run as string[]).map(expand);
  const proc = spawnSync(cmd, args, {
    cwd: join(ROOT, entry.cwd),
    input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (proc.error) throw proc.error;
  return { stdout: proc.stdout, stderr: proc.stderr, exitCode: proc.status };
}

export function listFixtures(): string[] {
  const ids: string[] = [];
  for (const dir of ['valid', 'invalid']) {
    for (const name of readdirSync(join(ROOT, 'fixtures', dir))) {
      if (name.endsWith('.yaml')) ids.push(name.replace(/\.yaml$/, ''));
    }
  }
  return ids.sort();
}

export function readVersions(): Record<string, { sdk: string; version: string }> {
  return JSON.parse(readFileSync(join(ROOT, 'runners', 'versions.json'), 'utf8'));
}

/** One matrix cell: the runner's parsed contract JSON, or a runner-bug marker. */
export type Cell = Record<string, unknown>;

function runCell(sdk: string, input: string): Cell {
  const res = runRunner(sdk, input);
  if (res.exitCode !== 0) {
    return { contract_violation: `runner exited ${res.exitCode}`, stderr_tail: res.stderr.slice(-400) };
  }
  try {
    return JSON.parse(res.stdout) as Cell;
  } catch {
    return { contract_violation: `unparseable stdout: ${res.stdout.slice(0, 200)}` };
  }
}

export function runMatrix(sdkFilter?: string, fixtureFilter?: string, outDir = join(ROOT, 'report')) {
  const sdks = Object.keys(readVersions()).filter((s) => !sdkFilter || s === sdkFilter).sort();
  const fixtures = listFixtures().filter((f) => !fixtureFilter || f === fixtureFilter);
  if (sdks.length === 0 || fixtures.length === 0) throw new Error('nothing to run — check --sdk/--fixture');
  const raw: Record<string, Record<string, Cell>> = {};
  for (const fixture of fixtures) {
    const input = toRunnerInput(loadFixture(fixture));
    raw[fixture] = {};
    for (const sdk of sdks) {
      raw[fixture][sdk] = runCell(sdk, input);
    }
    console.error(`[harness] ${fixture}: ${sdks.map((s) => (raw[fixture][s].contract_violation ? `${s}:VIOLATION` : s)).join(' ')}`);
  }
  if (sdkFilter || fixtureFilter) {
    // A filtered run never overwrites raw.json — the comparator must only
    // ever read a full-coverage matrix. Print the cells instead.
    process.stdout.write(JSON.stringify(raw, null, 2) + '\n');
    console.error(`[harness] filtered run (${fixtures.length} fixtures × ${sdks.length} SDKs) — raw.json NOT written`);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'raw.json');
  writeFileSync(out, JSON.stringify(raw, null, 2) + '\n');
  console.error(`[harness] wrote ${out} (${fixtures.length} fixtures × ${sdks.length} SDKs)`);
}

function main() {
  const { values, positionals } = parseArgs({
    options: {
      sdk: { type: 'string' }, fixture: { type: 'string' },
      all: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  if (values.all) {
    runMatrix(values.sdk, values.fixture);
    return;
  }
  if (!values.sdk || !values.fixture) {
    console.error('usage: npm run one -- --sdk <name> --fixture <id>   (or --all for the matrix)');
    process.exit(2);
  }
  const input = toRunnerInput(loadFixture(values.fixture));
  const result = runRunner(values.sdk, input);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0) {
    console.error(`[harness] runner exited ${result.exitCode} — contract violation (runner-bug)`);
    process.exit(1);
  }
  process.stdout.write(result.stdout);
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('run.ts');
if (invokedDirectly) main();
