// XDRParity determinism gate (CLAUDE.md invariant 1).
// Runs the full fixture × SDK matrix twice into fresh temp dirs and
// byte-compares every produced file. Any difference is a P0 bug: nonzero
// exit, with the first differing file named.
//
// Usage: npm run verify-determinism
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMatrix } from './run.ts';

function main() {
  const dirA = mkdtempSync(join(tmpdir(), 'xdrparity-det-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'xdrparity-det-b-'));
  try {
    console.error(`[determinism] run 1 → ${dirA}`);
    runMatrix(undefined, undefined, dirA);
    console.error(`[determinism] run 2 → ${dirB}`);
    runMatrix(undefined, undefined, dirB);

    const filesA = readdirSync(dirA).sort();
    const filesB = readdirSync(dirB).sort();
    if (filesA.join(',') !== filesB.join(',')) {
      console.error(`DETERMINISM FAILURE: file sets differ (${filesA} vs ${filesB})`);
      process.exit(1);
    }
    for (const file of filesA) {
      const a = readFileSync(join(dirA, file));
      const b = readFileSync(join(dirB, file));
      if (!a.equals(b)) {
        console.error(`DETERMINISM FAILURE: ${file} differs between two identical matrix runs`);
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
          if (a[i] !== b[i]) {
            console.error(`  first differing byte at offset ${i}`);
            break;
          }
        }
        process.exit(1);
      }
      console.log(`[determinism] ${file}: byte-identical across both runs (${a.length} bytes)`);
    }
    console.log('verify-determinism: PASS — two full matrix runs produced byte-identical output');
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
}

main();
