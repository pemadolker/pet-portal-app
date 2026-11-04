// Browser test of the real website against the real backend (objective O1:
// "the adoption journey works end to end in a browser"). Drives Chromium with
// Playwright through every role, takes screenshots for the report, and fails
// on any console error or Content-Security-Policy violation.
//
//   node tests/e2e/browser.mjs --url http://portal.local --admin-email ... --admin-password ... --out shots/
// It signs up several accounts from one IP: if the gateway answers 429, raise the limits first
// (experiments/loadtest-mode.sh on, in pet-portal-config) or wait a minute.

import { createRequire } from 'node:module';
import fs from 'node:fs';

// Playwright is a dev dependency (npm i -D playwright); createRequire also finds a global install.
const { chromium } = createRequire(import.meta.url)('playwright');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('url', 'http://127.0.0.1:8088');
const ADMIN = { email: arg('admin-email', 'admin@portal.local'), password: arg('admin-password', 'change-me-admin-pw') };
const OUT = arg('out', 'shots');
// --offline: answer Google Fonts requests locally (for sandboxes without internet); the page falls back to system fonts.
const OFFLINE = process.argv.includes('--offline');
fs.mkdirSync(OUT, { recursive: true });
const run = Date.now().toString(36).slice(-5);
const STAFF = { email: `sangay.${run}@thimphurescue.bt`, password: 'Shelter-pass-2026', name: 'Sangay Dorji', shelter: 'Thimphu Animal Rescue' };
const ADOPTER = { email: `karma.${run}@mail.bt`, password: 'Adopter-pass-2026', name: 'Karma Wangmo' };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
if (OFFLINE) await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

let n = 0;
const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: `${OUT}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: false }); };
const go = async (hash) => { await page.goto(`${URL_}/#${hash}`); await page.waitForLoadState('networkidle'); };
const logout = async () => {
  await page.click('#logoutBtn');
  await page.waitForSelector('#nav a[href="#/login"]');
  await page.waitForLoadState('networkidle');
};
async function login({ email, password }) {
  await go('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('#loginForm button[type=submit]');
  await page.waitForFunction(() => !location.hash.startsWith('#/login'));
  await page.waitForLoadState('networkidle');
}
const step = (s) => console.log(`- ${s}`);

try {
  await go('/');
  await shot('home');

  step('staff signs up with a new shelter');
  await go('/signup');
  await page.check('input[name=role][value=staff]');
  await page.fill('#name', STAFF.name);
  await page.fill('#email', STAFF.email);
  await page.fill('#password', STAFF.password);
  await page.fill('#district', 'Thimphu');
  await page.fill('#shelterName', STAFF.shelter);
  await page.click('#signupForm button[type=submit]');
  await page.waitForSelector('text=waiting for approval');
  await shot('staff-pending');
  await logout();

  step('admin approves the shelter');
  await login(ADMIN);
  await go('/admin');
  await shot('admin-pending');
  await page.locator('tr', { hasText: STAFF.shelter }).locator('button[data-status=approved]').first().click();
  await page.waitForSelector('text=Shelter approved');
  await logout();

  step('staff lists three pets');
  await login(STAFF);
  const pets = [
    ['Tashi', 'dog', 'Bhutanese mix', 'male', '26', 'medium', 'Tashi was found sleeping outside the Centenary Farmers Market. Calm, walks well on a lead and loves a belly rub.'],
    ['Pema', 'cat', 'Domestic short hair', 'female', '14', 'small', 'Pema is a quiet cat who likes sunny windows and soft blankets. Fine alone during the work day.'],
    ['Karma', 'rabbit', 'Lionhead', 'female', '10', 'small', 'Karma is litter trained and enjoys fresh coriander. Best with gentle older children.'],
  ];
  for (const [name, species, breed, sex, age, size, desc] of pets) {
    await go('/staff/pets/new');
    await page.fill('#name', name);
    await page.selectOption('#species', species);
    await page.fill('#breed', breed);
    await page.selectOption('#sex', sex);
    await page.fill('#ageMonths', age);
    await page.selectOption('#size', size);
    await page.fill('#description', desc);
    await page.check('input[name=vaccinated]');
    await page.check('input[name=goodWith][value=adults]');
    if (name === 'Tashi') await shot('staff-list-pet');
    await page.click('#petForm button[type=submit]');
    await page.waitForFunction(() => !location.hash.includes('/new'));
    await page.waitForLoadState('networkidle');
  }
  await go('/staff?tab=pets');
  await shot('staff-pets');
  await logout();

  step('adopter signs up, browses, saves and applies');
  await go('/signup');
  await page.fill('#name', ADOPTER.name);
  await page.fill('#email', ADOPTER.email);
  await page.fill('#password', ADOPTER.password);
  await page.fill('#district', 'Paro');
  await page.click('#signupForm button[type=submit]');
  await page.waitForFunction(() => location.hash.startsWith('#/pets'));
  await page.waitForSelector('text=Tashi', { timeout: 15000 });
  await shot('browse');
  await page.click('a:has-text("Tashi")');
  await page.waitForSelector('text=Apply to adopt Tashi');
  await page.click('button.fav-btn');
  await shot('pet-detail');
  await page.click('text=Apply to adopt Tashi');
  await page.waitForSelector('#applyForm');
  await page.selectOption('#homeType', 'house');
  await page.fill('#message', 'We live in a house with a fenced garden in Paro and I work from home most days.');
  await shot('apply');
  await page.click('#submitBtn');
  await page.waitForSelector('text=/sent|received|on its way/i');
  await shot('applied');
  await go('/applications');
  await shot('my-applications');
  await logout();

  step('staff approves the application');
  await login(STAFF);
  await go('/staff');
  await page.waitForSelector('form.decide');
  await shot('staff-dashboard');
  await page.fill('form.decide input[name=note]', 'Please visit on Saturday at 10am to meet Tashi.');
  await page.click('form.decide button[value=approved]');
  await page.waitForSelector('text=Application approved');
  await go('/reports');
  await page.waitForTimeout(1500);
  await go('/reports');
  await shot('reports');
  await logout();

  step('adopter sees the notification and history');
  await login(ADOPTER);
  await page.waitForTimeout(1000);
  await go('/notifications');
  await page.waitForSelector('text=approved');
  await shot('notifications');
  await go('/applications');
  await shot('history');
  await page.click('#openLog');
  await shot('request-log');

  const csp = problems.filter((p) => /Content Security Policy|Refused to/.test(p));
  console.log(`screenshots: ${n} in ${OUT}`);
  if (problems.length) { console.log('PROBLEMS:\n' + problems.join('\n')); process.exitCode = 1; }
  else console.log(`BROWSER JOURNEY PASS (no console errors, ${csp.length} CSP violations)`);
} catch (err) {
  await page.screenshot({ path: `${OUT}/failure.png` });
  console.error('FAILED:', err.message, '\n' + problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
