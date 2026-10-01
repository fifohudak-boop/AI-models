// End-to-end test: drives the real dashboard in a browser against a real
// Postiz (+ Temporal) stack and a mock Mastodon, and checks what Mastodon
// actually received. See README.md in this folder.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DASHBOARD = process.env.DASHBOARD_URL || 'http://localhost:3000';
const MOCK = process.env.MOCK_URL || 'http://mock-mastodon:4100';
const PASSWORD = process.env.DASHBOARD_PASSWORD;
const API_KEY = process.env.POSTIZ_API_KEY;
const VIDEO = process.env.TEST_VIDEO;
const OUT = process.env.ARTIFACTS || 'artifacts';
const executablePath = process.env.CHROMIUM_PATH || undefined;

assert.ok(PASSWORD, 'set DASHBOARD_PASSWORD');
assert.ok(API_KEY, 'set POSTIZ_API_KEY');
assert.ok(VIDEO && fs.existsSync(VIDEO), 'set TEST_VIDEO to a video file');
fs.mkdirSync(OUT, { recursive: true });

const received = async () => (await fetch(`${MOCK}/__received`)).json();
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
const step = (msg) => console.log(`\n▶ ${msg}`);

const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (err) => console.log('  [page error]', err.message));

try {
  step('Sign in');
  await page.goto(DASHBOARD);
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Wrong password.').waitFor();
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  step('One-time setup: paste the Postiz API key');
  await page.getByRole('heading', { name: 'One-time setup' }).waitFor();
  await shot(page, '01-setup');
  await page.getByLabel('Postiz API key').fill('not-a-real-key');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByText("Postiz didn't accept that key").waitFor();
  await page.getByLabel('Postiz API key').fill(API_KEY);
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByRole('link', { name: 'Accounts' }).waitFor();
  await shot(page, '02-post-empty');

  step('Connect an account through the real OAuth flow (mock Mastodon)');
  await page.getByRole('link', { name: 'Accounts' }).click();
  const tile = page.locator('.platform-tile', { hasText: 'Mastodon' });
  const [popup] = await Promise.all([page.waitForEvent('popup'), tile.getByRole('button', { name: 'Connect' }).click()]);
  await popup.locator('#authorize').waitFor({ timeout: 30_000 });
  await popup.locator('#authorize').click();
  await page.getByText('Connected AutoPost Test').waitFor({ timeout: 90_000 });
  await page.locator('.account', { hasText: 'AutoPost Test' }).waitFor();
  await shot(page, '03-accounts');
  assert.equal((await received()).tokens, 1, 'Postiz exchanged the OAuth code');

  step('Post the iPhone-style video with a tricky caption in one click');
  const caption = 'Tom & Jerry <3 "quotes" — émojis 🎉\nSecond line #autopost';
  await page.getByRole('link', { name: 'Post', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(VIDEO);
  await page.getByText('converted for all networks').waitFor({ timeout: 180_000 });
  await page.getByRole('textbox', { name: 'Caption' }).fill(caption);
  const account = page.locator('label.account', { hasText: 'AutoPost Test' });
  await account.getByText('/500').waitFor();
  assert.equal(await account.locator('input[type=checkbox]').isChecked(), true, 'new accounts start selected');
  await shot(page, '04-compose');
  await page.getByRole('button', { name: 'Post to 1 account' }).click();
  await page.locator('.chip.published').waitFor({ timeout: 180_000 });
  await shot(page, '05-published');

  let got = await received();
  assert.equal(got.statuses.length, 1);
  // Multipart forms always send line breaks as CRLF; everything else must be exact.
  assert.equal(got.statuses[0].status.replace(/\r\n/g, '\n'), caption, 'caption arrives exactly as typed (no &amp; etc.)');
  assert.equal(got.media.length, 1);
  assert.equal(got.media[0].isMp4, true, 'video arrives as MP4');
  assert.ok(got.media[0].bytes > 10_000);
  assert.deepEqual(got.statuses[0].mediaIds, [got.media[0].id], 'status carries the uploaded video');
  const link = await page.getByRole('link', { name: 'View post ↗' }).getAttribute('href');
  assert.ok(link?.includes('/statuses/1'), `link to the live post (${link})`);

  step('A failure shows the reason, and "Retry failed" fixes it');
  await page.getByRole('button', { name: 'New post' }).click();
  await page.getByRole('textbox', { name: 'Caption' }).fill('Text only post #failonce');
  await page.getByRole('button', { name: 'Post to 1 account' }).click();
  await page.locator('.chip.failed').waitFor({ timeout: 180_000 });
  await page.locator('.batch-error').waitFor();
  const reason = await page.locator('.batch-error').innerText();
  console.log(`  failure reason shown: ${reason}`);
  assert.match(reason, /media expired/i, 'shows the real reason from Mastodon');
  await shot(page, '06-failed');
  await page.getByRole('button', { name: /Retry 1 failed/ }).click();
  await page.locator('.chip.published').waitFor({ timeout: 180_000 });
  got = await received();
  assert.equal(got.rejected.length, 1);
  assert.equal(got.statuses.at(-1).status, 'Text only post #failonce');

  step('Schedule for later, then delete before it goes out');
  await page.getByRole('button', { name: 'New post' }).click();
  await page.getByRole('textbox', { name: 'Caption' }).fill('Scheduled post that gets cancelled');
  await page.getByRole('button', { name: 'Schedule' }).click();
  const later = new Date(Date.now() + 3 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  await page
    .locator('input[type=datetime-local]')
    .fill(`${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T${pad(later.getHours())}:${pad(later.getMinutes())}`);
  await page.getByRole('button', { name: 'Schedule to 1 account' }).click();
  await page.locator('.chip.scheduled').waitFor({ timeout: 30_000 });
  await page.getByRole('link', { name: 'History' }).click();
  await page.getByRole('heading', { name: 'History' }).waitFor();
  await page.locator('article').nth(2).waitFor({ timeout: 30_000 });
  await page.locator('article').first().locator('.chip.scheduled').waitFor({ timeout: 30_000 });
  await shot(page, '07-history');
  page.once('dialog', (d) => d.accept());
  await page.locator('article').first().getByRole('button', { name: 'Delete' }).click();
  await page.locator('article', { hasText: 'Scheduled post that gets cancelled' }).waitFor({ state: 'detached' });
  assert.equal(await page.locator('article').count(), 2, 'two posts left in history');

  step('Settings page renders');
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'TikTok' }).waitFor();
  await shot(page, '08-settings');

  console.log('\n✅ End-to-end test passed');
  console.log(`   Mastodon received: ${JSON.stringify(await received())}`);
} catch (err) {
  await shot(page, 'failure').catch(() => {});
  console.error('\n❌ End-to-end test failed:', err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
