import { useEffect, useState } from 'react';
import type { Preferences, Status } from '../types';
import { api } from '../api';

export function SettingsPage({ status, onLogout, toast }: { status: Status; onLogout: () => void; toast: (m: string) => void }) {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .preferences()
      .then(setPrefs)
      .catch((err) => setError(err.message));
  }, []);

  async function save(patch: Partial<Preferences>) {
    setPrefs((p) => (p ? { ...p, ...patch } : p));
    try {
      setPrefs(await api.savePreferences(patch));
      toast('Saved');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!prefs) return <p className="muted">{error ?? 'Loading…'}</p>;

  return (
    <div>
      <h1>Settings</h1>
      {error && <div className="notice error">{error}</div>}

      <section className="card stack">
        <h2>Captions</h2>
        <label className="check">
          <input type="checkbox" checked={prefs.autoShorten} onChange={(e) => save({ autoShorten: e.target.checked })} />
          <span>
            Shorten captions automatically when they're too long for a network (e.g. X's 280 characters)
            <span className="muted small" style={{ display: 'block' }}>
              Off = accounts with a too-long caption are skipped instead.
            </span>
          </span>
        </label>
      </section>

      <section className="card stack">
        <h2>YouTube</h2>
        <label className="field">
          <span>Video visibility</span>
          <select
            value={prefs.youtubeVisibility}
            onChange={(e) => save({ youtubeVisibility: e.target.value as Preferences['youtubeVisibility'] })}
          >
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </select>
        </label>
        <p className="muted small">
          Until Google approves your YouTube API project (free audit form), YouTube keeps every upload private no matter
          what you choose here.
        </p>
      </section>

      <section className="card stack">
        <h2>TikTok</h2>
        <label className="field">
          <span>Who can watch</span>
          <select
            value={prefs.tiktokPrivacy}
            onChange={(e) => save({ tiktokPrivacy: e.target.value as Preferences['tiktokPrivacy'] })}
          >
            <option value="PUBLIC_TO_EVERYONE">Everyone</option>
            <option value="FOLLOWER_OF_CREATOR">Followers</option>
            <option value="MUTUAL_FOLLOW_FRIENDS">Friends</option>
            <option value="SELF_ONLY">Only me</option>
          </select>
        </label>
        <div className="notice warn small">
          Until TikTok approves your developer app (its "audit"), TikTok only accepts <strong>Only me</strong>, and your
          TikTok account itself must be set to private. Switch to Everyone after approval.
        </div>
        <label className="field">
          <span>How to post</span>
          <select value={prefs.tiktokMode} onChange={(e) => save({ tiktokMode: e.target.value as Preferences['tiktokMode'] })}>
            <option value="DIRECT_POST">Publish directly</option>
            <option value="UPLOAD">Send to my TikTok inbox as a draft (I finish it in the app)</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.tiktokAllowComments}
            onChange={(e) => save({ tiktokAllowComments: e.target.checked })}
          />
          <span>Allow comments</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.tiktokAllowDuet} onChange={(e) => save({ tiktokAllowDuet: e.target.checked })} />
          <span>Allow Duets</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.tiktokAllowStitch}
            onChange={(e) => save({ tiktokAllowStitch: e.target.checked })}
          />
          <span>Allow Stitches</span>
        </label>
      </section>

      <section className="card stack">
        <h2>X (Twitter)</h2>
        <label className="field">
          <span>Who can reply</span>
          <select value={prefs.xWhoCanReply} onChange={(e) => save({ xWhoCanReply: e.target.value as Preferences['xWhoCanReply'] })}>
            <option value="everyone">Everyone</option>
            <option value="following">Accounts you follow</option>
            <option value="mentionedUsers">Only accounts you mention</option>
            <option value="verified">Verified accounts</option>
          </select>
        </label>
      </section>

      <section className="card stack">
        <h2>System</h2>
        <p>
          Postiz engine:{' '}
          <a href={status.postizUrl} target="_blank" rel="noreferrer">
            {status.postizUrl}
          </a>{' '}
          <span className="chip published">connected</span>
        </p>
        <p className="muted small">
          Postiz does the actual posting, retries and token refreshes. You rarely need to open it — but it's there for
          networks this dashboard doesn't cover.
        </p>
        <div className="row">
          <button className="btn" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </section>
    </div>
  );
}
