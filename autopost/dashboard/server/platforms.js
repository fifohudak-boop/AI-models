// Everything platform-specific the dashboard needs to turn one video + one
// caption into a valid Postiz post for every selected account. Pure functions
// only (no I/O) so they can be unit-tested.
import twitter from 'twitter-text';

// connect: 'oauth' opens the network's sign-in page; 'credentials' asks for a
// handle + app password in the dashboard; 'postiz' means connect it inside
// Postiz itself (still postable here once connected).
// media: 'video' = needs a video, 'any' = needs a photo or video, 'none' = text ok.
export const PLATFORMS = {
  youtube: {
    name: 'YouTube',
    env: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'],
    connect: 'oauth',
    media: 'video',
  },
  tiktok: {
    name: 'TikTok',
    env: ['TIKTOK_CLIENT_ID', 'TIKTOK_CLIENT_SECRET'],
    connect: 'oauth',
    media: 'any',
  },
  'instagram-standalone': {
    name: 'Instagram',
    env: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'],
    connect: 'oauth',
    media: 'any',
  },
  instagram: {
    name: 'Instagram (via Facebook Page)',
    env: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],
    connect: 'oauth',
    media: 'any',
  },
  facebook: {
    name: 'Facebook Page',
    env: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],
    connect: 'oauth',
    media: 'none',
  },
  threads: {
    name: 'Threads',
    env: ['THREADS_APP_ID', 'THREADS_APP_SECRET'],
    connect: 'oauth',
    media: 'none',
    maxVideoSeconds: 300,
  },
  x: {
    name: 'X (Twitter)',
    env: ['X_API_KEY', 'X_API_SECRET'],
    connect: 'oauth',
    media: 'none',
    maxVideoSeconds: 140,
  },
  linkedin: {
    name: 'LinkedIn',
    env: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    connect: 'oauth',
    media: 'none',
  },
  'linkedin-page': {
    name: 'LinkedIn Page',
    env: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    connect: 'oauth',
    media: 'none',
  },
  pinterest: {
    name: 'Pinterest',
    env: ['PINTEREST_CLIENT_ID', 'PINTEREST_CLIENT_SECRET'],
    connect: 'oauth',
    media: 'any',
    needsBoard: true,
  },
  bluesky: {
    name: 'Bluesky',
    env: [],
    connect: 'credentials',
    media: 'none',
    maxVideoSeconds: 180,
    maxVideoBytes: 100 * 1024 * 1024,
  },
  mastodon: {
    name: 'Mastodon',
    env: ['MASTODON_CLIENT_ID', 'MASTODON_CLIENT_SECRET'],
    connect: 'oauth',
    media: 'none',
  },
  telegram: { name: 'Telegram', env: [], connect: 'postiz', media: 'none' },
  nostr: { name: 'Nostr', env: [], connect: 'postiz', media: 'none' },
  vk: { name: 'VK', env: [], connect: 'postiz', media: 'none' },
};

export function isSupported(identifier) {
  return Object.hasOwn(PLATFORMS, identifier);
}

export function platformName(identifier) {
  return PLATFORMS[identifier]?.name ?? identifier;
}

// A platform can be connected once every developer key it needs is in .env.
export function platformCatalog(env) {
  return Object.entries(PLATFORMS)
    .filter(([, p]) => p.connect !== 'postiz')
    .map(([identifier, p]) => ({
      identifier,
      name: p.name,
      connect: p.connect,
      configured: p.env.every((key) => typeof env[key] === 'string' && env[key].trim() !== ''),
      missingKeys: p.env.filter((key) => !(typeof env[key] === 'string' && env[key].trim() !== '')),
    }));
}

export const DEFAULT_PREFERENCES = {
  youtubeVisibility: 'public', // public | unlisted | private
  tiktokPrivacy: 'PUBLIC_TO_EVERYONE', // SELF_ONLY until TikTok approves your app
  tiktokAllowComments: true,
  tiktokAllowDuet: false,
  tiktokAllowStitch: false,
  tiktokMode: 'DIRECT_POST', // DIRECT_POST publishes; UPLOAD sends to TikTok inbox as a draft
  xWhoCanReply: 'everyone',
  autoShorten: true,
  pinterestBoards: {}, // accountId -> numeric board id
};

// Character counting exactly as Postiz validates it.
export function countLength(identifier, text) {
  if (identifier === 'x') return twitter.parseTweet(text).weightedLength;
  if (identifier === 'threads') return new TextEncoder().encode(text).length;
  return text.length;
}

// Trims text to fit `max` (in the platform's own counting), cutting at a word
// boundary when possible and ending with an ellipsis.
export function fitCaption(identifier, text, max) {
  if (!max || countLength(identifier, text) <= max) return { text, shortened: false };
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = chars.slice(0, mid).join('').trimEnd() + '…';
    if (countLength(identifier, candidate) <= max) lo = mid;
    else hi = mid - 1;
  }
  let cut = chars.slice(0, lo).join('');
  const lastSpace = cut.search(/\s\S*$/);
  if (lastSpace > cut.length * 0.6) cut = cut.slice(0, lastSpace);
  return { text: cut.trimEnd() + '…', shortened: true };
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Postiz stores post bodies as the HTML its editor produces (one <p> per
// line) and converts them back to plain text per network. Sending raw text
// would leave entities like &amp; visible in the published post.
export function toPostizHtml(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
}

export function youtubeTitle(title, caption, fallback) {
  const firstLine = caption.split('\n').find((line) => line.trim() !== '') ?? '';
  let result = (title?.trim() || firstLine.trim() || fallback || 'New video').replace(/\s+/g, ' ');
  if (Array.from(result).length > 100) result = Array.from(result).slice(0, 99).join('').trimEnd() + '…';
  if (result.length < 2) result = `${result} video`.trim();
  return result;
}

// Settings object Postiz requires for each network (its per-provider DTOs).
export function buildSettings(account, { title, caption, mediaName }, prefs) {
  const p = { ...DEFAULT_PREFERENCES, ...prefs };
  const base = { __type: account.identifier };
  switch (account.identifier) {
    case 'youtube':
      return {
        ...base,
        title: youtubeTitle(title, caption, mediaName),
        type: p.youtubeVisibility,
        selfDeclaredMadeForKids: 'no',
        tags: [],
      };
    case 'tiktok':
    case 'tiktok-business':
      return {
        ...base,
        privacy_level: p.tiktokPrivacy,
        duet: !!p.tiktokAllowDuet,
        stitch: !!p.tiktokAllowStitch,
        comment: !!p.tiktokAllowComments,
        autoAddMusic: 'no',
        brand_content_toggle: false,
        brand_organic_toggle: false,
        video_made_with_ai: false,
        content_posting_method: p.tiktokMode,
      };
    case 'instagram':
    case 'instagram-standalone':
      return { ...base, post_type: 'post', collaborators: [] };
    case 'facebook':
      return { ...base, post_type: 'post', ...(title?.trim() ? { title: title.trim() } : {}) };
    case 'x':
      return { ...base, who_can_reply_post: p.xWhoCanReply, post_type: 'post' };
    case 'linkedin':
    case 'linkedin-page':
      return { ...base, post_as_images_carousel: false };
    case 'pinterest': {
      const pinTitle = (title?.trim() || caption.split('\n')[0] || '').trim();
      return {
        ...base,
        board: String(p.pinterestBoards?.[account.id] ?? ''),
        ...(pinTitle ? { title: Array.from(pinTitle).slice(0, 100).join('') } : {}),
      };
    }
    default:
      return base;
  }
}

// What media each network gets. Pinterest needs a cover image next to a video.
export function mediaFor(account, media) {
  if (!media) return [];
  if (media.kind === 'video') {
    const video = { id: media.video.id, path: media.video.path };
    if (account.identifier === 'pinterest' && media.cover) {
      return [video, { id: media.cover.id, path: media.cover.path }];
    }
    return [video];
  }
  return media.images.map((img) => ({ id: img.id, path: img.path }));
}

// Problems we can spot before sending anything, so the user sees them up front.
export function preflight(account, { media }, prefs) {
  const platform = PLATFORMS[account.identifier];
  const problems = [];
  const warnings = [];
  if (!platform) {
    problems.push('This network needs extra settings — post to it from Postiz instead.');
    return { problems, warnings };
  }
  if (account.disabled) problems.push('This account is disabled in Postiz.');
  if (platform.media === 'video' && media?.kind !== 'video') problems.push(`${platform.name} needs a video.`);
  if (platform.media === 'any' && !media) problems.push(`${platform.name} needs a photo or video.`);
  if (platform.needsBoard && !prefs?.pinterestBoards?.[account.id]) {
    problems.push('Pick a Pinterest board for this account (Accounts page).');
  }
  if (media?.kind === 'video') {
    if (platform.maxVideoSeconds && media.durationSeconds > platform.maxVideoSeconds) {
      warnings.push(
        `${platform.name} usually accepts videos up to ${formatDuration(platform.maxVideoSeconds)}; this one is ${formatDuration(media.durationSeconds)}.`
      );
    }
    if (platform.maxVideoBytes && media.sizeBytes > platform.maxVideoBytes) {
      warnings.push(`${platform.name} accepts videos up to ${Math.round(platform.maxVideoBytes / 1048576)} MB.`);
    }
  }
  return { problems, warnings };
}

export function formatDuration(totalSeconds) {
  const s = Math.round(totalSeconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// The full Postiz request for one account.
export function buildPostRequest(account, input, prefs, maxLength) {
  const p = { ...DEFAULT_PREFERENCES, ...prefs };
  const raw = input.captions?.[account.id] ?? input.caption;
  const fitted = p.autoShorten ? fitCaption(account.identifier, raw, maxLength) : { text: raw, shortened: false };
  return {
    shortened: fitted.shortened,
    body: {
      type: input.scheduleAt ? 'schedule' : 'now',
      date: input.scheduleAt ?? new Date().toISOString(),
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: account.id },
          value: [{ content: toPostizHtml(fitted.text), image: mediaFor(account, input.media) }],
          settings: buildSettings(account, { ...input, caption: raw }, p),
        },
      ],
    },
  };
}
