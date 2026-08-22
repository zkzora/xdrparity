// XDRParity matrix entry point — the single command CLAUDE.md documents:
//   npm run matrix                              full run → report/raw.json + matrix.{json,md,html}
//   npm run matrix -- --sdk js --fixture f007   one cell, printed only (raw.json untouched, no report)
// A single process so npm's appended "--" flags actually reach the filter
// (a chained script would attach them to the last command in the chain).
import { parseArgs } from 'node:util';
import { generateReport } from './report.ts';
import { runMatrix } from './run.ts';

const { values } = parseArgs({
  options: { sdk: { type: 'string' }, fixture: { type: 'string' } },
  allowPositionals: true,
});

runMatrix(values.sdk, values.fixture);
if (!values.sdk && !values.fixture) generateReport();
