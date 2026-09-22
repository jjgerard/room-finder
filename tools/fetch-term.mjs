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
// Playwright is imported further down, on demand. A static import fails before
// any of the checks below run, so somebody whose `npm install` had not
// finished got a module-resolution stack trace instead of being told to
// finish it.

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
  // One line, no shell continuation: the previous message used a bash-style
  // backslash, which PowerShell does not understand, so a Windows user
  // copying it got a second, more confusing error.
  console.error(
    (URL_ ? 'That does not look like a booking-type page:\n  ' + URL_ + '\n\n'
          : 'No booking-type page yet.\n\n') +
    'Open Resource Booker, go to the booking page, and copy the address from\n' +
    'the browser. It ends in /booking-types/ and a long id. Then:\n\n' +
    '  node tools/fetch-term.mjs --term ' + TERM +
    ' --url https://<your-host>/app/booking-types/<the-id>\n\n' +
    'It is remembered in .auth/config.json afterwards.');
  process.exit(1);
}
if (conf.bookingTypeUrl !== URL_) {
  fs.writeFileSync(CONF, JSON.stringify({ ...conf, bookingTypeUrl: URL_ }, null, 2));
}

const SNAPSHOT = fs.readFileSync(path.join(HERE, 'term-snapshot.js'), 'utf8');

// On Windows, PowerShell refuses npm's .ps1 wrapper unless the execution
// policy allows it, so the fix is named for both shells.
const INSTALL = process.platform === 'win32'
  ? '  npm.cmd install\n  npx.cmd playwright install chromium'
  : '  npm install\n  npx playwright install chromium';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. In this folder, run:\n\n' + INSTALL +
                (process.platform === 'win32'
                  ? '\n\n(the .cmd forms sidestep PowerShell\u2019s script policy)' : ''));
  process.exit(1);
}

console.log(`${TERM}: ${FROM} to ${TO}, week 1 starts ${WEEK1}`);
console.log('reader: waits for sign-in, polls');   // absent in older checkouts
console.log(`profile: ${path.relative(ROOT, AUTH)}  (delete it to sign in as somebody else)`);

let ctx;
try {
  ctx = await chromium.launchPersistentContext(AUTH, {
    headless: flag('headless'),
    viewport: { width: 1360, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
  });
} catch (e) {
  // The package is there but the browser binary is not — a separate download,
  // and the commonest thing to have skipped.
  if (/Executable doesn'?t exist|please run.*install/i.test(e.message)) {
    console.error('Playwright is installed but its browser is not. Run:\n\n' + INSTALL);
  } else {
    console.error('Could not start the browser:\n' + e.message);
  }
  process.exit(1);
}

// Before any of the app's own code: the same file the console route pastes.
await ctx.addInitScript({ content: SNAPSHOT });

let page = ctx.pages()[0] || await ctx.newPage();
// The in-page run logs its progress; relay it so the terminal shows something
// during the three minutes it spends reading rooms.
page.on('console', m => {
  const t = m.text();
  if (/^(Listing|Waiting|\s*\d+\/\d+|\d+ bookings|  session)/.test(t)) console.log('  ' + t);
});

console.log('opening the booking-type page…');
await page.goto(URL_, { waitUntil: 'domcontentloaded' });

// Sign-in is the person's job, and it takes the tab away to Microsoft and
// back. Checking the URL once, straight after goto, is no good: at that moment
// the tab is still on the address we asked for, so the check passes and the
// redirect happens afterwards — leaving the reader to run on the login page
// and, worse, to type its wake-up keystroke into somebody's password box.
//
// So poll, and require the booking page to still be there a moment later. The
// app having sent an authorised request of its own is better evidence still:
// only the booking app does that, so it means signed in AND on the right page.

// A plain sleep, not page.waitForTimeout: the page is navigating through
// sign-in for much of this, and a timer tied to its lifecycle throws when it
// does.
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function look() {
  // Mid-navigation the execution context is torn down, and the page object can
  // be replaced outright; both are a "not yet", not a crash.
  const p = ctx.pages().find(x => !x.isClosed()) || page;
  return p.evaluate(() => ({
    path: /\/booking-types\/[0-9a-f-]{36}/i.test(location.pathname),
    ready: !!(window.snapshotReady && window.snapshotReady()),
  })).catch(() => ({ path: false, ready: false }));
}

const DEADLINE = Date.now() + 10 * 60 * 1000;
const SETTLE = 15000;         // on the page this long with the app silent: proceed
let said = false, settledAt = 0, ready = false;

while (Date.now() < DEADLINE) {
  const st = await look();
  if (st.path && st.ready) { ready = true; break; }
  if (st.path) {
    if (!settledAt) settledAt = Date.now();
    if (Date.now() - settledAt > SETTLE) break;   // quiet app; provoke it below
  } else {
    settledAt = 0;
    if (!said) {
      console.log('waiting for sign-in… (a browser window is open — sign in there)');
      said = true;
    }
  }
  await sleep(1000);
}

if (!(await look()).path) {
  console.error('\nNot on the booking page. Sign in in the window that opened, or check the\n' +
                'address in .auth/config.json.');
  await ctx.close();
  process.exit(1);
}

// Sign-in can replace the page object, so take whichever one is live now.
page = ctx.pages().find(x => !x.isClosed()) || page;

// On the booking page but the app has sent nothing to replay: provoke one by
// typing the way a person would. Only ever here, never on a login page.
if (!ready) {
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

console.log('on: ' + page.url());
console.log('reading the term… (about 550 rooms, four at a time)');

let snap;
try {
  snap = await page.evaluate(
    o => window.snapshotTerm(o),
    { term: TERM, from: FROM, to: TO, weekOneMonday: WEEK1, download: false });
} catch (e) {
  // Say where the tab actually was. The commonest failure is the app having
  // moved somewhere else — a login page, a landing route — and an error that
  // does not name the URL leaves no way to tell that from a real fault.
  let where = '(could not read the address)';
  try { where = page.url(); } catch { /* page gone */ }
  console.error('\nthe read failed: ' + e.message.split('\n')[0]);
  console.error('the tab was on: ' + where);
  if (!/\/booking-types\/[0-9a-f-]{36}/i.test(where)) {
    console.error('\nThat is not the booking page, so the app had moved on by the time it\n' +
                  'was read. If it is a sign-in page, sign in and run this again — the\n' +
                  'session is kept. If it is some other page of the booking app, open the\n' +
                  'booking page you want, copy the address, and pass it as --url.');
  }
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
