// XDRParity report generator — renders report/raw.json into
// report/matrix.{json,md,html}: a fixture × SDK grid, PASS/FAIL per cell
// collapsed to the worst dimension, with per-mismatch diffs and links to
// confirmed-divergence notes. Reuses the comparator itself, so the matrix
// can never disagree with `npm run compare`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compareRaw, loadTriage, splitByTriage,
  type Dimension, type Mismatch, type RunnerBug, type TriageEntry,
} from './compare.ts';
import { listFixtures, loadFixture, readVersions } from './run.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const REPORT_DIR = join(ROOT, 'report');

const DIM_NAMES: Record<string, string> = {
  1: 'structure', 2: 'soroban auth', 3: 'sig payload hash', 4: 'xdr round-trip', 5: 'error stage',
};
// Worst-first ordering for the grid collapse (dim 3 is the strictest — CLAUDE.md).
const SEVERITY: Dimension[] = [3, 2, 1, 4, 5];

interface CellStatus {
  status: 'PASS' | 'FAIL' | 'RUNNER-BUG';
  dims: Dimension[];
  worst?: Dimension;
}

function sdksOfPair(pair: string): string[] {
  return pair.includes('↔') ? pair.split('↔') : [pair];
}

function buildCells(
  fixtures: string[], sdks: string[], mismatches: Mismatch[], runnerBugs: RunnerBug[],
): Record<string, Record<string, CellStatus>> {
  const cells: Record<string, Record<string, CellStatus>> = {};
  for (const f of fixtures) {
    cells[f] = {};
    for (const s of sdks) cells[f][s] = { status: 'PASS', dims: [] };
  }
  for (const b of runnerBugs) {
    if (cells[b.fixture]?.[b.sdk]) cells[b.fixture][b.sdk].status = 'RUNNER-BUG';
  }
  for (const m of mismatches) {
    for (const sdk of sdksOfPair(m.pair)) {
      const cell = cells[m.fixture]?.[sdk];
      if (!cell || cell.status === 'RUNNER-BUG') continue;
      cell.status = 'FAIL';
      if (!cell.dims.includes(m.dimension)) cell.dims.push(m.dimension);
    }
  }
  for (const f of fixtures) {
    for (const s of sdks) {
      const cell = cells[f][s];
      if (cell.dims.length > 0) cell.worst = SEVERITY.find((d) => cell.dims.includes(d));
    }
  }
  return cells;
}

function listDivergenceNotes(): string[] {
  const dir = join(REPORT_DIR, 'divergences');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
}

const cellText = (c: CellStatus) =>
  c.status === 'PASS' ? 'PASS' : c.status === 'RUNNER-BUG' ? 'RUNNER-BUG' : `FAIL d${c.worst}`;

const esc = (s: unknown) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The neutral reference decoder's identity (CLAUDE.md invariant 2): CLI
 * version, stellar-xdr crate version, and the XDR definitions commit.
 */
function referenceDecoder(): string[] {
  const proc = spawnSync('stellar', ['--version'], { encoding: 'utf8' });
  if (proc.error || proc.status !== 0) return ['unknown'];
  return proc.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const commit = l.match(/^xdr \(([0-9a-f]{12})[0-9a-f]*\)$/);
    return commit ? `XDR definitions ${commit[1]}` : l.replace(/\s*\(.*\)$/, '');
  });
}

function renderMarkdown(ctx: Context): string {
  const { fixtures, sdks, versions, cells, pending, triaged, runnerBugs, generated, protocolVersions, titles, decoder } = ctx;
  const lines: string[] = [];
  lines.push('# XDRParity Conformance Matrix', '');
  lines.push(`Generated: ${generated} • Protocol version: ${protocolVersions.join(', ')} • ` +
    `Fixtures: ${fixtures.filter((f) => f.startsWith('f')).length} valid + ` +
    `${fixtures.filter((f) => !f.startsWith('f')).length} invalid • SDKs: ${sdks.length}`, '');
  lines.push('| SDK | package | pinned version |', '|---|---|---|');
  for (const s of sdks) lines.push(`| ${s} | ${versions[s].sdk} | \`${versions[s].version}\` |`);
  lines.push('');
  lines.push(`Reference decoder (neutral — never an SDK under test): ${decoder.map((d) => `\`${d}\``).join(' · ')}`, '');
  lines.push('Legend: `PASS` — all five dimensions agree · `FAIL dN` — worst failing dimension ' +
    '(3 sig-payload-hash > 2 soroban-auth > 1 structure > 4 round-trip > 5 error-stage) · ' +
    '`RUNNER-BUG` — contract violation or invariant-6 failure, our bug, never SDK divergence. ' +
    'Failing cells link to the diff details below.', '');
  lines.push(`| fixture | title | ${sdks.join(' | ')} |`);
  lines.push(`|---|---|${sdks.map(() => '---').join('|')}|`);
  for (const f of fixtures) {
    const row = sdks.map((s) => {
      const c = cells[f][s];
      return c.status === 'PASS' ? 'PASS' : `[${cellText(c)}](#${f}-details)`;
    });
    lines.push(`| ${f} | ${titles[f] ?? ''} | ${row.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## Mismatch details', '');
  if (pending.length === 0 && triaged.length === 0 && runnerBugs.length === 0) {
    lines.push('None. Every cell agrees on every dimension, and invariant 6 holds for every cell.', '');
  } else {
    const byFixture = new Map<string, string[]>();
    const add = (f: string, s: string) => byFixture.set(f, [...(byFixture.get(f) ?? []), s]);
    for (const b of runnerBugs) add(b.fixture, `- **RUNNER-BUG** \`${b.sdk}\`: ${b.reason}`);
    for (const { mismatch: m, entry } of triaged) {
      add(m.fixture, `- **dim${m.dimension}** (${DIM_NAMES[m.dimension]}) \`${m.pair}\` at \`${m.path}\` — ` +
        `[${entry.label}] ${entry.note}${divergenceLink(entry)}\n  - a: \`${jstr(m.a)}\`\n  - b: \`${jstr(m.b)}\``);
    }
    for (const m of pending) {
      add(m.fixture, `- **dim${m.dimension}** (${DIM_NAMES[m.dimension]}) \`${m.pair}\` at \`${m.path}\` — ` +
        `**PENDING triage**\n  - a: \`${jstr(m.a)}\`\n  - b: \`${jstr(m.b)}\``);
    }
    for (const [f, items] of [...byFixture.entries()].sort()) {
      lines.push(`<a id="${f}-details"></a>`, `### ${f}`, '', ...items, '');
    }
  }

  lines.push('## Confirmed divergences', '');
  const notes = listDivergenceNotes();
  if (notes.length === 0) {
    lines.push('None so far — across the full matrix, all four SDKs produce byte-identical envelopes ' +
      'on every valid fixture and agree on every rejection stage.', '');
  } else {
    for (const n of notes) lines.push(`- [${n.replace(/\.md$/, '')}](divergences/${n})`);
    lines.push('');
  }
  return lines.join('\n');
}

const jstr = (v: unknown) => {
  const s = JSON.stringify(v);
  return s !== undefined && s.length > 100 ? `${s.slice(0, 97)}...` : s;
};

function divergenceLink(entry: TriageEntry): string {
  if (entry.label !== 'confirmed-divergence') return '';
  const id = entry.note.match(/[a-z0-9-]+(?=\.md)/)?.[0];
  return id ? ` ([repro](divergences/${id}.md))` : '';
}

function renderHtml(ctx: Context): string {
  const { fixtures, sdks, versions, cells, pending, triaged, runnerBugs, generated, protocolVersions, titles, decoder } = ctx;
  const cellHtml = (f: string, s: string) => {
    const c = cells[f][s];
    if (c.status === 'PASS') return '<td class="pass">PASS</td>';
    const cls = c.status === 'RUNNER-BUG' ? 'bug' : 'fail';
    return `<td class="${cls}"><a href="#${f}-details">${esc(cellText(c))}</a></td>`;
  };
  const detailBlocks: string[] = [];
  const byFixture = new Map<string, string[]>();
  const add = (f: string, s: string) => byFixture.set(f, [...(byFixture.get(f) ?? []), s]);
  for (const b of runnerBugs) add(b.fixture, `<li><b>RUNNER-BUG</b> <code>${esc(b.sdk)}</code>: ${esc(b.reason)}</li>`);
  for (const { mismatch: m, entry } of triaged) {
    add(m.fixture, `<li><b>dim${m.dimension}</b> (${DIM_NAMES[m.dimension]}) <code>${esc(m.pair)}</code> at ` +
      `<code>${esc(m.path)}</code> — [${entry.label}] ${esc(entry.note)}` +
      `<br>a: <code>${esc(jstr(m.a))}</code><br>b: <code>${esc(jstr(m.b))}</code></li>`);
  }
  for (const m of pending) {
    add(m.fixture, `<li><b>dim${m.dimension}</b> (${DIM_NAMES[m.dimension]}) <code>${esc(m.pair)}</code> at ` +
      `<code>${esc(m.path)}</code> — <b>PENDING triage</b>` +
      `<br>a: <code>${esc(jstr(m.a))}</code><br>b: <code>${esc(jstr(m.b))}</code></li>`);
  }
  for (const [f, items] of [...byFixture.entries()].sort()) {
    detailBlocks.push(`<details id="${f}-details" open><summary><b>${f}</b> — ${esc(titles[f] ?? '')}</summary>` +
      `<ul>${items.join('')}</ul></details>`);
  }
  const notes = listDivergenceNotes();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>XDRParity Conformance Matrix</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; color: #1a1a1a; background: #fff; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.9rem; }
  th, td { border: 1px solid #d0d0d0; padding: 0.35rem 0.6rem; text-align: left; }
  th { background: #f4f4f4; }
  td.pass { background: #e6f4ea; color: #137333; }
  td.fail { background: #fce8e6; } td.fail a { color: #c5221f; font-weight: 600; }
  td.bug { background: #fef7e0; } td.bug a { color: #b06000; font-weight: 600; }
  code { background: #f4f4f4; padding: 0.05rem 0.3rem; border-radius: 3px; font-size: 0.85em; }
  details { margin: 0.5rem 0; } .meta { color: #5f6368; font-size: 0.9rem; }
</style></head><body>
<h1>XDRParity Conformance Matrix</h1>
<p class="meta">Generated: ${esc(generated)} • Protocol version: ${esc(protocolVersions.join(', '))} •
Fixtures: ${fixtures.filter((f) => f.startsWith('f')).length} valid + ${fixtures.filter((f) => !f.startsWith('f')).length} invalid</p>
<table><tr><th>SDK</th><th>package</th><th>pinned version</th></tr>
${sdks.map((s) => `<tr><td>${esc(s)}</td><td>${esc(versions[s].sdk)}</td><td><code>${esc(versions[s].version)}</code></td></tr>`).join('\n')}
</table>
<p class="meta">Reference decoder (neutral — never an SDK under test): ${decoder.map((d) => `<code>${esc(d)}</code>`).join(' · ')}</p>
<p class="meta">Legend: PASS — all five dimensions agree · FAIL dN — worst failing dimension
(3 sig-payload-hash &gt; 2 soroban-auth &gt; 1 structure &gt; 4 round-trip &gt; 5 error-stage) ·
RUNNER-BUG — contract violation or invariant-6 failure (our bug, never SDK divergence).</p>
<table><tr><th>fixture</th><th>title</th>${sdks.map((s) => `<th>${esc(s)}</th>`).join('')}</tr>
${fixtures.map((f) => `<tr><td>${f}</td><td>${esc(titles[f] ?? '')}</td>${sdks.map((s) => cellHtml(f, s)).join('')}</tr>`).join('\n')}
</table>
<h2>Mismatch details</h2>
${detailBlocks.length === 0
    ? '<p>None. Every cell agrees on every dimension, and invariant 6 holds for every cell.</p>'
    : detailBlocks.join('\n')}
<h2>Confirmed divergences</h2>
${notes.length === 0
    ? '<p>None so far — all four SDKs produce byte-identical envelopes on every valid fixture.</p>'
    : `<ul>${notes.map((n) => `<li><a href="divergences/${n}">${n.replace(/\.md$/, '')}</a></li>`).join('')}</ul>`}
</body></html>
`;
}

interface Context {
  fixtures: string[];
  sdks: string[];
  versions: Record<string, { sdk: string; version: string }>;
  cells: Record<string, Record<string, CellStatus>>;
  pending: Mismatch[];
  triaged: Array<{ mismatch: Mismatch; entry: TriageEntry }>;
  runnerBugs: RunnerBug[];
  generated: string;
  protocolVersions: string[];
  titles: Record<string, string>;
  decoder: string[];
}

/** Generate report/matrix.{json,md,html} from report/raw.json. Sets the process exit code on pending/runner-bug states. */
export function generateReport() {
  const rawPath = join(REPORT_DIR, 'raw.json');
  if (!existsSync(rawPath)) {
    console.error('[report] report/raw.json not found — run `npm run matrix` first');
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  const fixtures = Object.keys(raw).sort();
  const versions = readVersions();
  const sdks = Object.keys(versions).sort();
  const { mismatches, runnerBugs } = compareRaw(raw);
  const { triaged, pending } = splitByTriage(mismatches, loadTriage());
  const cells = buildCells(fixtures, sdks, mismatches, runnerBugs);

  const titles: Record<string, string> = {};
  const protoSet = new Set<string>();
  for (const f of listFixtures()) {
    const fx = loadFixture(f) as { title?: string; protocol_version?: unknown };
    titles[f] = String(fx.title ?? '');
    protoSet.add(String(fx.protocol_version ?? '?'));
  }

  const ctx: Context = {
    fixtures, sdks, versions, cells, pending, triaged, runnerBugs,
    generated: new Date().toISOString(),
    protocolVersions: [...protoSet].sort(),
    titles,
    decoder: referenceDecoder(),
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, 'matrix.json'), JSON.stringify({
    generated: ctx.generated, protocol_versions: ctx.protocolVersions, versions,
    reference_decoder: ctx.decoder,
    cells, mismatches, runner_bugs: runnerBugs,
    pending_triage: pending.length,
  }, null, 2) + '\n');
  writeFileSync(join(REPORT_DIR, 'matrix.md'), renderMarkdown(ctx));
  writeFileSync(join(REPORT_DIR, 'matrix.html'), renderHtml(ctx));
  console.log(`[report] wrote report/matrix.{json,md,html} — ` +
    `${fixtures.length} fixtures × ${sdks.length} SDKs, ` +
    `${mismatches.length} mismatch(es), ${runnerBugs.length} runner bug(s), ${pending.length} pending triage`);
  if (pending.length > 0) process.exitCode = 3; // untriaged mismatches must fail the matrix command
  if (runnerBugs.length > 0) process.exitCode = 2;
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('report.ts');
if (invokedDirectly) generateReport();
