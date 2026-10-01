import { useState } from 'react';

const BADGES: Record<string, { label: string; color: string }> = {
  youtube: { label: 'YT', color: '#e00030' },
  tiktok: { label: 'TT', color: '#111111' },
  'tiktok-business': { label: 'TT', color: '#111111' },
  instagram: { label: 'IG', color: '#d62976' },
  'instagram-standalone': { label: 'IG', color: '#d62976' },
  facebook: { label: 'FB', color: '#1877f2' },
  threads: { label: '@', color: '#111111' },
  x: { label: 'X', color: '#111111' },
  linkedin: { label: 'in', color: '#0a66c2' },
  'linkedin-page': { label: 'in', color: '#0a66c2' },
  pinterest: { label: 'P', color: '#e60023' },
  bluesky: { label: 'BS', color: '#1185fe' },
  mastodon: { label: 'M', color: '#6364ff' },
  telegram: { label: 'TG', color: '#229ed9' },
};

export function PlatformBadge({ identifier }: { identifier: string }) {
  const badge = BADGES[identifier] ?? { label: identifier.slice(0, 2).toUpperCase(), color: '#6b7280' };
  return (
    <span className="badge" style={{ background: badge.color }} aria-hidden="true">
      {badge.label}
    </span>
  );
}

export function AccountAvatar({ name, picture, identifier }: { name: string; picture: string | null; identifier: string }) {
  const [broken, setBroken] = useState(false);
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="avatar">
      {picture && !broken ? (
        <img src={picture} alt="" onError={() => setBroken(true)} />
      ) : (
        <span className="initials">{initials || '?'}</span>
      )}
      <PlatformBadge identifier={identifier} />
    </span>
  );
}
