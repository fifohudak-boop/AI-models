// First run on a fresh server: create the Postiz account and its API key
// automatically, so nobody has to open Postiz, sign up and copy keys around.
// Runs in the background until Postiz answers (its first start can take
// several minutes). Installations that already have a key are left alone.
import { randomBytes } from 'node:crypto';
import { BRAND_NAME, DASHBOARD_DOMAIN, getApiKey, saveSettings } from './config.js';
import { postiz } from './postiz.js';

// 'idle' | 'waiting' (Postiz still starting) | 'done' | 'taken' (someone
// already signed up in Postiz: paste the key by hand) | 'error'
let state = { phase: 'idle', detail: null };

export function autoSetupState() {
  return state;
}

function randomSecret(length) {
  return randomBytes(length * 2)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, length);
}

export function ownerEmail(domain = DASHBOARD_DOMAIN) {
  // ".localhost" is reserved and never receives mail.
  const host = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain.toLowerCase() : 'fifofarm.localhost';
  return `owner@${host}`;
}

export async function trySetupOnce() {
  if (getApiKey()) {
    state = { phase: 'done', detail: null };
    return state.phase;
  }
  let open;
  try {
    open = await postiz.canRegister();
  } catch (err) {
    state = { phase: 'waiting', detail: err.message };
    return state.phase;
  }
  if (!open) {
    state = { phase: 'taken', detail: null };
    return state.phase;
  }
  const email = ownerEmail();
  const password = randomSecret(24);
  try {
    const jwt = await postiz.register({ email, password, company: BRAND_NAME });
    const apiKey = await postiz.publicApiKey(jwt);
    if (!apiKey) throw new Error('Postiz returned no API key.');
    saveSettings({ postizApiKey: apiKey, postizLogin: { email, password, createdAt: new Date().toISOString() } });
    state = { phase: 'done', detail: null };
    console.log(`Created the Postiz account (${email}) and saved its API key.`);
  } catch (err) {
    state = { phase: 'error', detail: err.message };
    console.error('Automatic Postiz setup failed:', err.message);
  }
  return state.phase;
}

// Keep trying every 15 s for up to an hour while Postiz boots.
export function startAutoSetup() {
  if (getApiKey()) {
    state = { phase: 'done', detail: null };
    return;
  }
  state = { phase: 'waiting', detail: null };
  const started = Date.now();
  const tick = async () => {
    const phase = await trySetupOnce();
    if (phase === 'waiting' && Date.now() - started < 60 * 60 * 1000) setTimeout(tick, 15_000).unref();
  };
  setTimeout(tick, 2_000).unref();
}
