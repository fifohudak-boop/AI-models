// Forgot the password? On the server run:
//   docker compose exec dashboard node server/reset-password.js
// It prints a new password and signs out every browser.
import { randomBytes } from 'node:crypto';
import { getSettings, saveSettings } from './config.js';
import { hashPassword } from './auth.js';

const password = randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
saveSettings({ passwordHash: hashPassword(password), passwordVersion: getSettings().passwordVersion + 1 });
console.log(`New Fifofarm password: ${password}`);
console.log('Sign in with it, then change it in Settings → Password if you like.');
