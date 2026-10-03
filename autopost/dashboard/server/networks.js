// Everything needed to set up each network's "developer app" from inside the
// dashboard (Settings → Networks / Accounts → Set up), so nobody has to edit
// .env or open a terminal. Pure data + pure functions, unit-tested.

// Developer keys only ever contain these characters. Anything else (spaces,
// quotes, newlines) is a copy/paste mistake and could break .env.
export const KEY_VALUE_PATTERN = /^[A-Za-z0-9._:/@+=-]{1,400}$/;

// One entry per developer app. `platforms` are the dashboard networks it
// unlocks; `redirects` are the Postiz callback paths to register in the app.
export const NETWORK_SETUPS = [
  {
    id: 'instagram',
    title: 'Instagram',
    platforms: ['instagram-standalone'],
    console: { label: 'Meta for Developers', url: 'https://developers.facebook.com/apps/' },
    redirects: ['instagram-standalone'],
    fields: [
      { env: 'INSTAGRAM_APP_ID', label: 'Instagram app ID' },
      { env: 'INSTAGRAM_APP_SECRET', label: 'Instagram app secret', secret: true },
    ],
    steps: [
      'Open Meta for Developers → Create app. Name it (e.g. "Fifofarm"), pick the use case "Manage messaging & content on Instagram", choose "I don\'t want to connect a business portfolio yet", then Create app.',
      'Use cases → Customize → Permissions and features: click Add next to instagram_business_basic, instagram_business_content_publish, instagram_business_manage_comments and instagram_business_manage_insights.',
      'API setup with Instagram login → step 4 "Set up Instagram business login" → Set up → paste the redirect URL below → Save.',
      'App roles → Roles → Add People → Instagram Tester → type your Instagram username. Then, logged in as that account on instagram.com, open Settings → Apps and websites → Tester invites → Accept.',
      'API setup with Instagram login: copy the Instagram app ID and the Instagram app secret (click Show) into the fields below.',
    ],
    notes: [
      'Each Instagram account must be a Professional account (Creator or Business). Switching is free in the Instagram app: Settings → Account type and tools.',
      'Until Meta approves your app (App Review), every Instagram account you connect must first be added as an Instagram Tester and accept the invite (step 4).',
    ],
  },
  {
    id: 'tiktok',
    title: 'TikTok',
    platforms: ['tiktok'],
    console: { label: 'TikTok for Developers', url: 'https://developers.tiktok.com/apps/' },
    redirects: ['tiktok'],
    verification: true,
    fields: [
      { env: 'TIKTOK_CLIENT_ID', label: 'Client key' },
      { env: 'TIKTOK_CLIENT_SECRET', label: 'Client secret', secret: true },
    ],
    steps: [
      'Open TikTok for Developers → Manage apps → Connect an app. Fill in the name, an icon and a short description. Use the Terms of Service and Privacy Policy links below. Platform: Web, website = your Fifofarm address.',
      'Add products: Login Kit (paste the redirect URL below) and Content Posting API (turn on Direct Post).',
      'Scopes: user.info.basic, user.info.profile, user.info.stats, video.list, video.upload, video.publish.',
      'URL properties → Add URL prefix → enter your posting-engine address (shown below) → choose "Signature file" → download the file and upload it here under "Verification file", then click Verify in TikTok.',
      'Copy the Client key and Client secret into the fields below. Then submit the app for review in TikTok.',
    ],
    notes: [
      'Until TikTok approves your app, posts can only be "Only me", the TikTok account must be private, and at most 5 accounts can post per day. Set Settings → TikTok → Who can watch → Only me meanwhile.',
    ],
  },
  {
    id: 'youtube',
    title: 'YouTube',
    platforms: ['youtube'],
    console: { label: 'Google Cloud Console', url: 'https://console.cloud.google.com/apis/credentials' },
    redirects: ['youtube'],
    fields: [
      { env: 'YOUTUBE_CLIENT_ID', label: 'Client ID' },
      { env: 'YOUTUBE_CLIENT_SECRET', label: 'Client secret', secret: true },
    ],
    steps: [
      'In Google Cloud Console create a project. APIs & Services → Library: enable YouTube Data API v3, YouTube Analytics API and YouTube Reporting API.',
      'OAuth consent screen: user type External, add your Google account as a test user, then click Publish app (so logins don\'t expire every 7 days).',
      'Credentials → Create credentials → OAuth client ID → Web application → add the redirect URL below.',
      'Copy the Client ID and Client secret into the fields below.',
    ],
    notes: [
      'Google keeps uploads from new API projects private until the project passes a free audit (YouTube API Services audit form). You can make videos public in YouTube Studio meanwhile.',
    ],
  },
  {
    id: 'facebook',
    title: 'Facebook Pages (+ Instagram via a Page)',
    platforms: ['facebook', 'instagram'],
    console: { label: 'Meta for Developers', url: 'https://developers.facebook.com/apps/' },
    redirects: ['facebook', 'instagram'],
    fields: [
      { env: 'FACEBOOK_APP_ID', label: 'App ID' },
      { env: 'FACEBOOK_APP_SECRET', label: 'App secret', secret: true },
    ],
    steps: [
      'Meta for Developers → Create app → use case "Other" → type "Business".',
      'Add Facebook Login for Business and add both redirect URLs below.',
      'Permissions: pages_show_list, pages_manage_posts, pages_manage_engagement, pages_read_engagement, business_management, read_insights (and instagram_basic, instagram_content_publish for Instagram via a Page).',
      'App settings → Basic: copy the App ID and App secret into the fields below.',
      'Switch the app from Development to Live (top bar), otherwise only you can see the posts.',
    ],
    notes: [],
  },
  {
    id: 'threads',
    title: 'Threads',
    platforms: ['threads'],
    console: { label: 'Meta for Developers', url: 'https://developers.facebook.com/apps/' },
    redirects: ['threads'],
    fields: [
      { env: 'THREADS_APP_ID', label: 'Threads app ID' },
      { env: 'THREADS_APP_SECRET', label: 'Threads app secret', secret: true },
    ],
    steps: [
      'Meta for Developers → Create app → use case "Access the Threads API".',
      'Permissions: threads_basic, threads_content_publish, threads_manage_replies, threads_manage_insights.',
      'Add the redirect URL below (click the URL after pasting it, or Meta won\'t save it).',
      'App roles → Add people → Threads Tester → your Threads username; accept it in Threads → Settings → Account → Website permissions.',
      'Copy the Threads app ID and secret into the fields below.',
    ],
    notes: [],
  },
  {
    id: 'x',
    title: 'X (Twitter)',
    platforms: ['x'],
    console: { label: 'X Developer Portal', url: 'https://developer.x.com/en/portal/dashboard' },
    redirects: ['x'],
    fields: [
      { env: 'X_API_KEY', label: 'API key (Consumer key)' },
      { env: 'X_API_SECRET', label: 'API key secret', secret: true },
    ],
    steps: [
      'X Developer Portal → create a project and app, and add a few dollars of credit (posting costs about $0.015 per post).',
      'User authentication settings: permissions Read and write, app type Native App (not Web App), callback URL = the redirect URL below.',
      'Keys and tokens → Consumer Keys → Regenerate, then copy the API key and secret into the fields below.',
    ],
    notes: [],
  },
  {
    id: 'linkedin',
    title: 'LinkedIn',
    platforms: ['linkedin', 'linkedin-page'],
    console: { label: 'LinkedIn Developers', url: 'https://www.linkedin.com/developers/apps' },
    redirects: ['linkedin', 'linkedin-page'],
    fields: [
      { env: 'LINKEDIN_CLIENT_ID', label: 'Client ID' },
      { env: 'LINKEDIN_CLIENT_SECRET', label: 'Client secret', secret: true },
    ],
    steps: [
      'LinkedIn Developers → Create app (it must be attached to a Company Page; a placeholder page is fine).',
      'Products: request Share on LinkedIn, Sign In with LinkedIn using OpenID Connect and Advertising API.',
      'Auth → add both redirect URLs below.',
      'Copy the Client ID and Client secret into the fields below.',
    ],
    notes: [],
  },
  {
    id: 'pinterest',
    title: 'Pinterest',
    platforms: ['pinterest'],
    console: { label: 'Pinterest Developers', url: 'https://developers.pinterest.com/apps/' },
    redirects: ['pinterest'],
    fields: [
      { env: 'PINTEREST_CLIENT_ID', label: 'App ID' },
      { env: 'PINTEREST_CLIENT_SECRET', label: 'App secret', secret: true },
    ],
    steps: [
      'With a Pinterest business account, create an app at Pinterest Developers and wait for approval.',
      'Add the redirect URL below.',
      'Copy the App ID and secret into the fields below. After connecting, pick a board per account on the Accounts page.',
    ],
    notes: [],
  },
  {
    id: 'mastodon',
    title: 'Mastodon',
    platforms: ['mastodon'],
    console: { label: 'mastodon.social', url: 'https://mastodon.social/settings/applications' },
    redirects: ['mastodon'],
    fields: [
      { env: 'MASTODON_URL', label: 'Instance address', placeholder: 'https://mastodon.social' },
      { env: 'MASTODON_CLIENT_ID', label: 'Client key' },
      { env: 'MASTODON_CLIENT_SECRET', label: 'Client secret', secret: true },
    ],
    steps: [
      'On your Mastodon instance: Preferences → Development → New application.',
      'Redirect URI = the redirect URL below. Scopes: profile, write:statuses, write:media.',
      'Copy your instance address, the client key and the client secret into the fields below.',
    ],
    notes: [],
  },
];

export const SETUP_ENV_KEYS = new Set(NETWORK_SETUPS.flatMap((s) => s.fields.map((f) => f.env)));

function isSet(env, key) {
  return typeof env[key] === 'string' && env[key].trim() !== '';
}

// What the UI needs: steps, the exact redirect URLs for *this* server, and
// which fields are already filled in (never the values themselves).
export function setupCatalog(env, { postizUrl, dashboardUrl }) {
  const base = (postizUrl || '').replace(/\/+$/, '');
  return NETWORK_SETUPS.map((s) => ({
    id: s.id,
    title: s.title,
    platforms: s.platforms,
    console: s.console,
    steps: s.steps,
    notes: s.notes,
    verification: !!s.verification,
    redirectUrls: s.redirects.map((p) => `${base}/integrations/social/${p}`),
    verificationPrefix: s.verification ? `${base}/` : null,
    legal: dashboardUrl ? { terms: `${dashboardUrl}/legal/terms`, privacy: `${dashboardUrl}/legal/privacy` } : null,
    fields: s.fields.map((f) => ({
      env: f.env,
      label: f.label,
      secret: !!f.secret,
      placeholder: f.placeholder ?? '',
      filled: isSet(env, f.env),
    })),
    configured: s.fields.every((f) => isSet(env, f.env)),
  }));
}

// Checks the values typed into a setup form. Returns the clean changes or a
// human-readable error.
export function validateSetupValues(setupId, values) {
  const setup = NETWORK_SETUPS.find((s) => s.id === setupId);
  if (!setup) return { error: 'Unknown network.' };
  if (!values || typeof values !== 'object') return { error: 'Nothing to save.' };
  const changes = {};
  for (const field of setup.fields) {
    const raw = values[field.env];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string') return { error: `${field.label}: invalid value.` };
    const value = raw.trim();
    if (!KEY_VALUE_PATTERN.test(value)) {
      return { error: `${field.label} contains spaces or characters that keys never have — copy it again.` };
    }
    if (field.env === 'MASTODON_URL' && !/^https:\/\/[A-Za-z0-9.-]+\/?$/.test(value)) {
      return { error: 'Instance address must look like https://mastodon.social' };
    }
    changes[field.env] = value;
  }
  if (Object.keys(changes).length === 0) return { error: 'Fill in at least one field.' };
  return { changes };
}

// Makes a network's sign-in page let you pick (or log in to) a different
// account instead of silently reusing the one already logged in, so you can
// add a second, third, ... account. Appends parameters without re-encoding the
// rest of the URL.
export function withAccountChooser(identifier, url) {
  if (typeof url !== 'string' || !url) return url;
  const add = (param) => `${url}${url.includes('?') ? '&' : '?'}${param}`;
  switch (identifier) {
    case 'instagram-standalone':
      return /[?&]force_reauth=/.test(url) ? url : add('force_reauth=true');
    case 'tiktok':
      return /[?&]disable_auto_auth=/.test(url) ? url : add('disable_auto_auth=1');
    case 'youtube':
      return /[?&]prompt=/.test(url)
        ? url.replace(/([?&]prompt=)[^&]*/, '$1select_account%20consent')
        : add('prompt=select_account%20consent');
    case 'x':
      return /[?&]force_login=/.test(url) ? url.replace(/([?&]force_login=)[^&]*/, '$1true') : add('force_login=true');
    default:
      return url;
  }
}

// Site-verification files (TikTok "URL prefix" signature files and the like).
export const VERIFICATION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,120}\.txt$/;
export function validateVerificationFile(name, content) {
  if (typeof name !== 'string' || !VERIFICATION_NAME_PATTERN.test(name)) {
    return { error: 'The file name should look like tiktokXXXXXXXX.txt' };
  }
  if (typeof content !== 'string' || content.length === 0 || content.length > 2000 || /[^\x20-\x7e\r\n\t]/.test(content)) {
    return { error: "That doesn't look like a verification file." };
  }
  return { name, content };
}
