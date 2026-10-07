// Plain public pages that developer apps ask for (TikTok, Meta, Google):
// Terms of Service, Privacy Policy and data-deletion instructions. A simple,
// honest template for a private posting tool run by its owner — adjust the
// wording if Fifofarm is ever offered to the public.
const PAGES = {
  terms: {
    title: 'Terms of Service',
    body: (b) => `
<p>${b.name} is a private tool its owner uses to publish their own content to their own social media accounts.
It is not offered to the public.</p>
<p>By connecting a social media account to ${b.name} you confirm that you own that account or are authorised to
manage it, and that the content published through ${b.name} follows the rules of each social network.</p>
<p>${b.name} is provided as is, without warranty. Access can be removed at any time by disconnecting the account in
${b.name} or in the social network's app settings.</p>`,
  },
  privacy: {
    title: 'Privacy Policy',
    body: (b) => `
<p>${b.name} stores only what it needs to publish posts for the accounts connected to it: the access tokens the
social networks issue, basic profile information (name, username, profile picture) and the posts and media you
create. Everything is stored on ${b.name}'s own server${b.domain ? ` (${b.domain})` : ''}.</p>
<p>Data is used only to publish and schedule your posts and show their status. It is never sold or shared with
third parties, except with the social network a post is published to.</p>
<p>You can remove your data at any time: disconnect the account in ${b.name} (Accounts → Disconnect), or revoke
access in the social network's settings. See <a href="/legal/data-deletion">data deletion</a>.</p>
${b.contact ? `<p>Contact: <a href="mailto:${b.contact}">${b.contact}</a></p>` : ''}`,
  },
  'data-deletion': {
    title: 'Data deletion',
    body: (b) => `
<p>To delete the data ${b.name} holds about a social media account:</p>
<ol>
<li>Open ${b.name} → Accounts and click <strong>Disconnect</strong> next to the account. Its access tokens and
scheduled posts are deleted.</li>
<li>Optionally also revoke access in the social network (for Instagram: Settings → Apps and websites; for
TikTok: Settings → Security → Manage app permissions).</li>
</ol>
${b.contact ? `<p>Or email <a href="mailto:${b.contact}">${b.contact}</a> and we delete it for you.</p>` : ''}`,
  },
};

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function legalPage(kind, { name, domain, contact }) {
  const page = PAGES[kind];
  if (!page) return null;
  const safeContact = /^[^\s@<>"]+@[^\s@<>"]+\.[A-Za-z]{2,}$/.test(contact || '') ? contact : '';
  const b = { name: escapeHtml(name), domain: escapeHtml(domain || ''), contact: escapeHtml(safeContact) };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title} · ${b.name}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 16px;color:#16181d}
h1{font-size:24px}a{color:#2f7d4f}</style></head>
<body><h1>${b.name} — ${page.title}</h1>${page.body(b)}</body></html>`;
}
