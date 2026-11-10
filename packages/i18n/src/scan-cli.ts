/**
 * Lists the text left outside the catalogs in the given files or directories:
 *   node --experimental-strip-types packages/i18n/src/scan-cli.ts apps/manager/app/(dashboard)/fines
 */
import { findHardCodedText, tsxFiles } from './testing.ts';

const found = findHardCodedText(tsxFiles(...process.argv.slice(2)));
for (const f of found) process.stdout.write(`${f.file}:${f.line}  ${f.text}\n`);
process.stdout.write(`${found.length} hard-coded text(s)\n`);
process.exitCode = found.length ? 1 : 0;
