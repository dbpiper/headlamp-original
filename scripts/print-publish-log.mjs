import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const pkgJsonPath = resolve(rootDir, 'package.json');
const pkgRaw = await readFile(pkgJsonPath, 'utf8');
const pkg = JSON.parse(pkgRaw);

const date = new Date();
// Detect the user's/system timezone; fall back to TZ env or UTC if unavailable
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? process.env.TZ ?? 'UTC';
// Friendly: "5:58 PM" (narrow no-break space before AM/PM to prevent wrapping)
const ts = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: tz,
  // If you want "CDT"/"CST", uncomment:
  // timeZoneName: 'short',
})
  .format(date)
  .replace(' AM', '\u202FAM')
  .replace(' PM', '\u202FPM');

// eslint-disable-next-line no-console
console.log(`[${ts}] ${pkg.name}@${pkg.version} published in store.`);
