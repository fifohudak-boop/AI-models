// Forgot a password? On the server run:
//   docker compose exec dashboard node server/reset-password.js            (the owner)
//   docker compose exec dashboard node server/reset-password.js ana@x.com  (someone on the team)
// It prints a new password and signs that person out everywhere.
import { randomBytes } from 'node:crypto';
import { ensureOwner, findUserByEmail, ownerUser, setPassword } from './users.js';

ensureOwner();
const email = process.argv[2];
const user = email ? findUserByEmail(email) : ownerUser();
if (!user) {
  console.error(email ? `Nobody with the email ${email}.` : 'No owner account yet. Start Fifofarm once first.');
  process.exit(1);
}
const password = randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
setPassword(user.id, password);
console.log(`New Fifofarm password for ${user.email || 'the owner'}: ${password}`);
console.log('Sign in with it, then change it in Settings → Your account if you like.');
