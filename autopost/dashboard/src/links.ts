// "#/signup" is the sign-up link the owner shares with the team.
export const SIGNUP_HASH = '/signup';

export function isSignupLink() {
  return window.location.hash.startsWith(`#${SIGNUP_HASH}`);
}

export function signupLink() {
  return `${window.location.origin}/#${SIGNUP_HASH}`;
}
