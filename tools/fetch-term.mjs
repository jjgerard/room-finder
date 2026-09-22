// Reads a term out of Resource Booker without anybody touching a console.
//
//   node tools/fetch-term.mjs --term autumn
//
// The console route asks you to paste 13 KB into a devtools window that often
// wants "allow pasting" typed first, and — the real problem — it can only
// capture the app's request headers from requests made AFTER the paste. By
// then the app has already made the ones it makes on load, so the usual
// outcome was a script that sat there having captured nothing. Here the
// capture is installed with addInitScript, which runs before any of the page's
// own code, so there is no window to miss.
//
// The browser is real and visible. Sign in yourself the first time — Microsoft
// SSO, MFA, whatever your account asks for. The profile is kept in .auth/ so
// later runs reuse the session and need no attention at all.
//
// It never reads the token. The fetching runs inside the page, replaying the
// header bag the app filled in, and what comes back across the driver is the
// finished rows. Read-only throughout: it lists resources and reads busy
// times, and never submits a booking.
//
// Options:
//   --term autumn|spring       which term (default autumn)
//   --from / --to / --week1    override the dates
//   --url <booking-type page>  first run only; remembered afterwards
//   --out <file>               where to write (default timetable/data/…)
//   --headless                 no window; only works once a session is saved
//   --refresh                  run refresh.js --dry-run on the result

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const AUTH = path.join(ROOT, '.auth');
const CONF = path.join(AUTH, 'config.json');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
}
const flag = name => process.argv.includes('--' + name);

// Term dates. Only defaults — a term that moves is corrected on the command
// line, and the choice is echoed back before anything is fetched.
const TERMS = {
  autumn: { from: '2026-09-21', to: '2026-12-18', week1: '2026-09-21' },
  spring: { from: '2027-01-25', to: '2027-05-14', week1: '2027-01-25' },
};

const TERM = arg('term', 'autumn');
if (!TERMS[TERM]) {
  console.error(`unknown term "${TERM}" — expected autumn or spring`);
  process.exit(1);
}
const FROM = arg('from', TERMS[TERM].from);
const TO = arg('to', TERMS[TERM].to);
const WEEK1 = arg('week1', TERMS[TERM].week1);
const OUT = path.resolve(arg('out', path.join(ROOT, 'timetable', 'data', `snapshot-${TERM}.json`)));

// The booking-type page, remembered so it is typed once.
fs.mkdirSync(AUTH, { recursive: true });
let conf = {};
try { conf = JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch { /* first run */ }
const URL_ = arg('url', conf.bookingTypeUrl || '');
// https everywhere except loopback, which is how this is tested against a
// stand-in tenant without weakening the check for real use.
const OK_URL = /^https:\/\/.+\/booking-types\/[0-9a-f-]{36}/i.test(URL_) ||
  /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/.+\/booking-types\/[0-9a-f-]{36}/i.test(URL_);
if (!OK_URL) {
  console.error('Give the booking-type page once with --url:\n' +
                '  node tools/fetch-term.mjs --term autumn \\\n' +
                '    --url https://…/app/booking-types/<id>\n' +
                'It is remembered in .auth/config.json afterwards.');
  process.exit(1);
}
if (conf.bookingTypeUrl !== URL_) {
  fs.writeFileSync(CONF, JSON.stringify({ ...conf, bookingTypeUrl: URL_ }, null, 2));
}

const SNAPSHOT = fs.readFileSync(path.join(HERE, 'term-snapshot.js'), 'utf8');

console.log(`${TERM}: ${FROM} to ${TO}, week 1 starts ${WEEK1}`);
console.log(`profile: ${path.relative(ROOT, AUTH)}  (delete it to sign in as somebody else)`);

const ctx = await chromium.launchPersistentContext(AUTH, {
  headless: flag('headless'),
  viewport: { width: 1360, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
  ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
});

// Before any of the app's own code: the same file the console route pastes.
await ctx.addInitScript({ content: SNAPSHOT });

const page = ctx.pages()[0] || await ctx.newPage();
// The in-page run logs its progress; relay it so the terminal shows something
// during the three minutes it spends reading rooms.
page.on('console', m => {
  const t = m.text();
  if (/^(Listing|Waiting|\s*\d+\/\d+|\d+ bookings|  session)/.test(t)) console.log('  ' + t);
});

console.log('opening the booking-type page…');
await page.goto(URL_, { waitUntil: 'domcontentloaded' });

// Sign-in is the person's job, and SSO takes the tab away to Microsoft and
// back. Being on the booking-type page again is what "signed in" looks like
// from here; nothing is read from the login pages in between.
if (!/\/booking-types\/[0-9a-f-]{36}/i.test(page.url())) {
  console.log('waiting for sign-in… (a browser window is open — sign in there)');
}
try {
  await page.waitForFunction(
    () => /\/booking-types\/[0-9a-f-]{36}/i.test(location.pathname),
    null, { timeout: 10 * 60 * 1000, polling: 1000 });
} catch {
  console.error('\nStill not on the booking-type page after ten minutes. Sign in, or check ' +
                'the address in .auth/config.json.');
  await ctx.close();
  process.exit(1);
}

// The app has to send one request of its own before its headers can be
// replayed. It usually does on load; when it does not, provoke one by typing
// in the page the way a person would. snapshotTerm will try again by itself,
// so this is a head start rather than a gate — blocking here on an app that
// happens to be quiet is exactly the trap the console route fell into.
if (!(await page.evaluate(() => window.snapshotReady && window.snapshotReady()))) {
  const box = page.locator('input:visible').first();
  if (await box.count()) {
    await box.click({ timeout: 5000 }).catch(() => {});
    await box.type('b', { delay: 60 }).catch(() => {});
    await box.press('Backspace').catch(() => {});
  }
  await page.waitForFunction(() => window.snapshotReady && window.snapshotReady(),
                             null, { timeout: 20000, polling: 500 })
    .catch(() => console.log('  the app is quiet; the reader will provoke it itself'));
}
console.log('reading the term… (about 550 rooms, four at a time)');

let snap;
try {
  snap = await page.evaluate(
    o => window.snapshotTerm(o),
    { term: TERM, from: FROM, to: TO, weekOneMonday: WEEK1, download: false });
} catch (e) {
  console.error('\nthe read failed: ' + e.message);
  await ctx.close();
  process.exit(1);
}
await ctx.close();

if (!snap || !snap.rows || !snap.rows.length) {
  console.error('nothing came back — no bookings in that range?');
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(snap));
console.log(`\nwrote ${path.relative(ROOT, OUT)} — ${snap.rows.length} bookings, ` +
            `${snap.rooms.length} rooms`);

// The check nobody should skip, offered rather than assumed.
if (flag('refresh')) {
  const { spawnSync } = await import('child_process');
  console.log('\n--- what would change ---');
  spawnSync(process.execPath,
    [path.join(ROOT, 'timetable', 'refresh.js'), '--in', OUT, '--dry-run'],
    { stdio: 'inherit' });
}
console.log(`\nnext: node timetable/refresh.js --in ${path.relative(ROOT, OUT)} --dry-run`);
