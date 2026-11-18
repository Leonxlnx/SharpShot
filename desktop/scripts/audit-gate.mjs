// Dependency audit gate for SharpShot Studio.
//
// Runs `npm audit --json` and fails on any high or critical advisory, like
// `npm audit --audit-level=high`, except advisories listed in
// audit-allowlist.json. Every allowlist entry needs a reason and an expiry
// date; an expired entry fails the gate so it gets revisited.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const allowlistPath = join(desktopRoot, 'audit-allowlist.json');
const failing = new Set(['high', 'critical']);

const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const allowed = new Map();
let problems = 0;

for (const entry of allowlist.advisories ?? []) {
  const valid =
    /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/.test(entry.id ?? '') &&
    typeof entry.package === 'string' && entry.package.length > 0 &&
    typeof entry.reason === 'string' && entry.reason.length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(entry.expires ?? '');
  if (!valid) {
    console.error(`Invalid allowlist entry: ${JSON.stringify(entry)}`);
    problems++;
    continue;
  }
  if (entry.expires < today) {
    console.error(`Allowlist entry ${entry.id} (${entry.package}) expired on ${entry.expires}. Re-check it, then renew or remove it.`);
    problems++;
    continue;
  }
  allowed.set(entry.id, entry);
}

let raw;
try {
  raw = execFileSync('npm', ['audit', '--json'], {
    cwd: desktopRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  // npm audit exits non-zero whenever it finds anything; the JSON is still on stdout.
  raw = error.stdout;
  if (!raw) throw error;
}

const report = JSON.parse(raw);
if (report.error) {
  console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(1);
}

const seen = new Set();
for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via) {
    // String entries are transitive links; the advisory itself is reported on its own package.
    if (typeof via !== 'object' || !failing.has(via.severity)) continue;
    const id = String(via.url ?? '').split('/').pop();
    if (seen.has(`${name} ${id}`)) continue;
    seen.add(`${name} ${id}`);
    const entry = allowed.get(id);
    if (entry && entry.package === name) {
      console.log(`allowed  ${via.severity.padEnd(8)} ${name} ${id}: ${via.title} (until ${entry.expires})`);
      continue;
    }
    console.error(`FAIL     ${via.severity.padEnd(8)} ${name} ${id}: ${via.title} [${via.range}]`);
    problems++;
  }
}

if (problems > 0) {
  console.error(`\nDependency audit gate failed: ${problems} problem(s). Run \`npm audit\` for details.`);
  process.exit(1);
}
console.log('Dependency audit gate passed: no high or critical advisories outside audit-allowlist.json.');
