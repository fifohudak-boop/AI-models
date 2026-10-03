import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NETWORK_SETUPS,
  SETUP_ENV_KEYS,
  setupCatalog,
  validateSetupValues,
  validateVerificationFile,
  withAccountChooser,
} from '../server/networks.js';
import { PLATFORMS } from '../server/platforms.js';

test('every setup unlocks known platforms and covers exactly their env keys', () => {
  for (const setup of NETWORK_SETUPS) {
    for (const id of setup.platforms) {
      assert.ok(PLATFORMS[id], `${setup.id} → unknown platform ${id}`);
      for (const key of PLATFORMS[id].env) {
        assert.ok(setup.fields.some((f) => f.env === key), `${setup.id} is missing field ${key}`);
      }
    }
  }
});

test('every platform that needs keys has a setup', () => {
  for (const [id, p] of Object.entries(PLATFORMS)) {
    if (p.env.length === 0) continue;
    assert.ok(NETWORK_SETUPS.some((s) => s.platforms.includes(id)), `no setup for ${id}`);
  }
});

test('catalog shows redirect URLs for this server and never the key values', () => {
  const env = { INSTAGRAM_APP_ID: '950687494262728', INSTAGRAM_APP_SECRET: 'supersecret' };
  const list = setupCatalog(env, { postizUrl: 'https://postiz.example.org/', dashboardUrl: 'https://example.org' });
  const ig = list.find((s) => s.id === 'instagram');
  assert.deepEqual(ig.redirectUrls, ['https://postiz.example.org/integrations/social/instagram-standalone']);
  assert.equal(ig.configured, true);
  assert.ok(ig.fields.every((f) => f.filled));
  assert.ok(!JSON.stringify(list).includes('supersecret'));
  const tiktok = list.find((s) => s.id === 'tiktok');
  assert.equal(tiktok.verificationPrefix, 'https://postiz.example.org/');
  assert.equal(tiktok.legal.privacy, 'https://example.org/legal/privacy');
  assert.equal(tiktok.configured, false);
});

test('validateSetupValues trims, rejects pasted junk and unknown networks', () => {
  assert.deepEqual(validateSetupValues('instagram', { INSTAGRAM_APP_ID: ' 950687494262728 ', INSTAGRAM_APP_SECRET: '' }), {
    changes: { INSTAGRAM_APP_ID: '950687494262728' },
  });
  assert.match(validateSetupValues('instagram', { INSTAGRAM_APP_SECRET: 'abc def' }).error, /spaces/);
  assert.match(validateSetupValues('instagram', { INSTAGRAM_APP_SECRET: 'abc"; rm -rf /' }).error, /spaces|characters/);
  assert.match(validateSetupValues('instagram', { TIKTOK_CLIENT_ID: 'x' }).error, /Fill in/);
  assert.match(validateSetupValues('nope', {}).error, /Unknown/);
  assert.match(validateSetupValues('mastodon', { MASTODON_URL: 'mastodon.social' }).error, /https/);
  assert.deepEqual(validateSetupValues('mastodon', { MASTODON_URL: 'https://mastodon.social' }), {
    changes: { MASTODON_URL: 'https://mastodon.social' },
  });
});

test('setup env keys are only network keys', () => {
  for (const key of SETUP_ENV_KEYS) assert.match(key, /^[A-Z_]+_(ID|SECRET|KEY|URL)$/);
  assert.ok(!SETUP_ENV_KEYS.has('JWT_SECRET'));
  assert.ok(!SETUP_ENV_KEYS.has('DASHBOARD_PASSWORD'));
});

test('withAccountChooser asks the network which account to use', () => {
  const ig = 'https://www.instagram.com/oauth/authorize?enable_fb_login=0&client_id=1&redirect_uri=https%3A%2F%2Fp.example%2Fx&scope=a%2Cb&state=s';
  assert.equal(withAccountChooser('instagram-standalone', ig), `${ig}&force_reauth=true`);
  assert.equal(withAccountChooser('instagram-standalone', `${ig}&force_reauth=true`), `${ig}&force_reauth=true`);
  assert.equal(
    withAccountChooser('youtube', 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent&state=s'),
    'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=select_account%20consent&state=s'
  );
  assert.equal(
    withAccountChooser('x', 'https://api.twitter.com/oauth/authenticate?oauth_token=t&force_login=false'),
    'https://api.twitter.com/oauth/authenticate?oauth_token=t&force_login=true'
  );
  assert.equal(withAccountChooser('tiktok', 'https://www.tiktok.com/v2/auth/authorize/?client_key=k'), 'https://www.tiktok.com/v2/auth/authorize/?client_key=k&disable_auto_auth=1');
  assert.equal(withAccountChooser('linkedin', 'https://www.linkedin.com/oauth?x=1'), 'https://www.linkedin.com/oauth?x=1');
});

test('verification files: only plain .txt names and short text', () => {
  assert.deepEqual(validateVerificationFile('tiktokAbC123.txt', 'tiktok-developers-site-verification=xyz'), {
    name: 'tiktokAbC123.txt',
    content: 'tiktok-developers-site-verification=xyz',
  });
  assert.ok(validateVerificationFile('../etc/passwd.txt', 'x').error);
  assert.ok(validateVerificationFile('index.html', 'x').error);
  assert.ok(validateVerificationFile('a.txt', '').error);
  assert.ok(validateVerificationFile('a.txt', 'x'.repeat(3000)).error);
});
