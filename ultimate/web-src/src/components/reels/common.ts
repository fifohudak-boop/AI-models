// Labels and helpers shared by the Reel Finder screens (same wording as the Reel Finder app).
export const PLATFORM_NAMES: Record<string, string> = { tiktok: 'TikTok', instagram: 'Instagram', pinterest: 'Pinterest' };
export const PLATFORM_BADGE: Record<string, string> = { tiktok: 'TikTok', instagram: 'IG', pinterest: 'Pinterest' };

export const RECOMMENDED_MODELS = [
  { name: 'qwen3-vl:8b-instruct', note: 'recommended, sees thumbnails, ~6 GB, best on 16 GB Macs' },
  { name: 'gemma3:4b', note: 'smaller and faster, sees thumbnails, ~3.3 GB, fine on 8 GB Macs' },
];

export const STATUS_TEXT: Record<string, string> = {
  queued: 'Waiting to be checked',
  checking: 'AI is checking',
  scored: 'Checked',
  picked: 'Picked — saving soon',
  downloading: 'Saving',
  watching: 'Checking the frames',
  downloaded: '✓ Saved',
  skipped: 'Skipped (your filters)',
  notpicked: 'Checked — not in the top picks',
  failed: "Couldn't save — next best used instead",
  unchecked: 'Not checked (stopped)',
};

export const AGENT_STATE: Record<string, string> = {
  opening: 'Opening search',
  scrolling: 'Scrolling',
  captcha: 'Needs you: captcha',
  login: 'Needs you: log in',
  error: 'Error',
  done: 'Finished',
  limited: 'Not logged in — first results only',
};

export const PHASE_TEXT: Record<string, string> = {
  starting: 'Starting the agents…',
  searching: 'Looking at videos',
  checking: 'Scoring the last videos',
  downloading: 'Saving the best ones',
  done: 'Done',
};

export const BEST_STATES = ['scored', 'picked', 'downloading', 'watching', 'downloaded', 'notpicked'];

export function autoPool(target: number) {
  return Math.min(Math.max(target * 4, target + 20, 40), 600);
}

// Mirrors the engine's similarity.closeness_label() and min_look().
export function closenessLabel(v: number) {
  return v < 35 ? 'Same kind of video' : v < 70 ? 'Same look' : v < 90 ? 'Very close' : 'Nearly identical';
}

export function closenessHint(v: number) {
  const floor = v < 50 ? 0 : Math.round((v - 50) * 1.4);
  if (v < 35) return 'Same subject and vibe, any style. Always saves the number you asked for.';
  if (!floor) return 'Same subject, setting and style — the most alike are saved first. Always saves the number you asked for.';
  const strict = v >= 70 ? ' May save fewer than you asked for if not enough are found.' : '';
  return `Videos that look less than ${floor}% like your reference are left out, also after checking their frames.${strict}`;
}

export function fmtNumber(n: number | null | undefined) {
  if (n === null || n === undefined) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

export function fmtTime(sec: number) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
