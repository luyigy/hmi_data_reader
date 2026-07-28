import { captureLongFileBaseline, longFileNotice } from '../src/lib/long-file-guard';

async function main() {
  const baseline = await captureLongFileBaseline(process.cwd());
  console.log(longFileNotice(baseline).trim() || `No files at or above ${baseline.rules.blocking} lines.`);
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
