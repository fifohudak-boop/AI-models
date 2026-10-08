import { useCallback, useEffect, useState } from 'react';
import type { Preferences, Session, Status, SystemInfo, TeamInfo, User } from '../types';
import { api } from '../api';
import { CopyField } from '../components/CopyField';
import { formatWhen } from '../format';

function when(iso: string | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function SystemCard({ system, onReload, toast }: { system: SystemInfo; onReload: () => void; toast: (m: string) => void }) {
  const update = system.host.update;
  const on = system.host.available && system.host.helperActive && !!update?.autoUpdate;
  const [busy, setBusy] = useState(false);
  return (
    <section className="card stack">
      <h2>{system.brand}</h2>
      <p className="small">
        Version{' '}
        <strong>{update?.commit || 'unknown'}</strong>
        {update?.subject && <span className="muted"> — {update.subject}</span>}
        {update?.commitDate && <span className="muted"> ({when(update.commitDate)})</span>}
      </p>
      {on ? (
        <>
          <p className="small">
            <span className="chip published">automatic updates on</span>{' '}
            <span className="muted">
              Follows the "{update?.branch}" branch. Last check: {when(update?.checkedAt)}. {update?.message}
            </span>
          </p>
          {update?.state === 'failed' && <div className="notice error small">{update.message}</div>}
          {update?.state === 'updating' && <div className="notice info small">Installing a new version…</div>}
          <div className="row">
            <button
              className="btn small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.checkUpdates();
                  toast('Checking for updates — this takes up to a minute');
                  setTimeout(onReload, 65_000);
                } catch (err) {
                  toast((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Check for updates now
            </button>
          </div>
        </>
      ) : (
        <div className="notice warn small">
          Automatic updates aren't switched on for this server yet, so improvements and saved network keys aren't applied
          automatically.
        </div>
      )}
    </section>
  );
}

function ProfileCard({ user, onSession, toast }: { user: User; onSession: (s: Session) => void; toast: (m: string) => void }) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = name.trim() !== user.name || email.trim() !== (user.email ?? '');
  return (
    <section className="card">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            onSession(await api.updateMe({ name, ...(email.trim() ? { email } : {}) }));
            toast('Saved');
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="card-head" style={{ marginBottom: 0 }}>
          <h2>Your account</h2>
          <span className={`chip ${user.role === 'owner' ? 'published' : ''}`}>{user.role === 'owner' ? 'owner' : 'team member'}</span>
        </div>
        {!user.email && (
          <div className="notice info small">Add your email: from then on you sign in with your email and password.</div>
        )}
        <label className="field">
          <span>Name</span>
          <input type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Email (you sign in with it)</span>
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {error && <div className="notice error small">{error}</div>}
        <div className="row">
          <button className="btn primary small" disabled={busy || !changed || !name.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  );
}

function TeamCard({ me, toast }: { me: User; toast: (m: string) => void }) {
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reset, setReset] = useState<{ name: string; password: string } | null>(null);
  const signupLink = `${window.location.origin}/#/signup`;

  const load = useCallback(() => {
    api
      .team()
      .then(setTeam)
      .catch((err) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  if (!team) return <section className="card muted">{error ?? 'Loading team…'}</section>;
  const members = team.users.filter((u) => u.id !== me.id);

  return (
    <section className="card stack">
      <h2>Team</h2>
      <p className="muted small">
        Everyone signs in with their own email and password. Team members see and post to only the accounts they
        connected (and their own History and Analytics); you see everything and can move an account to someone on the
        Accounts page.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={team.signupsOpen}
          onChange={async (e) => {
            try {
              const res = await api.setSignups(e.target.checked);
              setTeam({ ...team, signupsOpen: res.signupsOpen });
              toast(res.signupsOpen ? 'Sign-up is open' : 'Sign-up is closed');
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
        <span>
          Anyone with the link can create an account
          <span className="muted small" style={{ display: 'block' }}>
            Turn this off once your team has joined, so strangers can't sign up.
          </span>
        </span>
      </label>
      {team.signupsOpen && <CopyField label="Sign-up link to send your team" value={signupLink} />}
      {error && <div className="notice error small">{error}</div>}
      {reset && (
        <div className="notice ok small stack">
          <span>
            New password for {reset.name} — send it to them; they can change it in Settings after signing in.
          </span>
          <CopyField value={reset.password} />
          <button className="btn link small" onClick={() => setReset(null)}>
            Hide
          </button>
        </div>
      )}
      {members.length === 0 ? (
        <p className="muted small">Nobody else has joined yet.</p>
      ) : (
        <div className="account-list">
          {members.map((u) => (
            <div className="account" key={u.id}>
              <div className="avatar">
                <span className="initials">{u.name.slice(0, 2).toUpperCase()}</span>
              </div>
              <div className="account-main">
                <div className="account-name">{u.name}</div>
                <div className="account-meta">
                  {u.email} · {u.accounts} account{u.accounts === 1 ? '' : 's'} · {u.posts} post{u.posts === 1 ? '' : 's'}
                  {u.lastLoginAt && ` · last signed in ${formatWhen(u.lastLoginAt)}`}
                </div>
              </div>
              <div className="row">
                <button
                  className="btn small"
                  onClick={async () => {
                    if (!window.confirm(`Give ${u.name} a new password? Their current one stops working.`)) return;
                    try {
                      const res = await api.resetMemberPassword(u.id);
                      setReset({ name: u.name, password: res.password });
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                >
                  New password
                </button>
                <button
                  className="btn danger small"
                  onClick={async () => {
                    if (!window.confirm(`Remove ${u.name}? Their connected accounts move to you; nothing is disconnected.`)) return;
                    try {
                      await api.removeMember(u.id);
                      toast(`Removed ${u.name}`);
                      load();
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PasswordCard({ toast }: { toast: (m: string) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.changePassword(current, next);
            setCurrent('');
            setNext('');
            toast('Password changed — your other browsers have to sign in again');
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>Password</h2>
        <p className="muted small">Changing it signs you out of your other browsers and devices.</p>
        <label className="field">
          <span>Current password</span>
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="field">
          <span>New password (at least 8 characters, visible so you can check it)</span>
          <input type="text" autoComplete="new-password" spellCheck={false} value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        {error && <div className="notice error small">{error}</div>}
        <div className="row">
          <button className="btn primary small" disabled={busy || !current || next.length < 8}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </form>
    </section>
  );
}

function DomainCard({ system }: { system: SystemInfo }) {
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const d = system.domains;
  return (
    <section className="card stack">
      <h2>Domain</h2>
      {d.serverMode ? (
        <>
          <p className="small">
            Fifofarm: <strong>{d.dashboard}</strong> · posting engine: <strong>{d.postiz}</strong>
          </p>
          {moved ? (
            <div className="notice ok small">
              Moving now. In about 2 minutes open <a href={moved}>{moved}</a> and sign in there. Then, for each network
              you use, add the new redirect URL in its developer app (Accounts → network → Setup shows it).
            </div>
          ) : (
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError(null);
                try {
                  const res = await api.changeDomain(domain);
                  setMoved(res.dashboardUrl);
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <p className="muted small">
                Bought your own domain (e.g. fifofarm.com)? At your domain provider, point <code>yourdomain</code> and{' '}
                <code>postiz.yourdomain</code> to this server (an "A" record with the same IP as {d.dashboard}), then
                enter it here. Fifofarm checks it and moves itself, including HTTPS certificates.
              </p>
              <label className="field">
                <span>New domain</span>
                <input type="text" placeholder="fifofarm.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
              </label>
              {error && <div className="notice error small">{error}</div>}
              <div className="row">
                <button className="btn small" disabled={busy || domain.trim().length < 4}>
                  {busy ? 'Checking…' : 'Move Fifofarm to this domain'}
                </button>
              </div>
            </form>
          )}
        </>
      ) : (
        <p className="muted small">Running on this computer ({d.dashboardUrl || 'localhost'}). A domain needs server mode.</p>
      )}
    </section>
  );
}

function EngineCard({ system, status }: { system: SystemInfo; status: Status }) {
  const [show, setShow] = useState(false);
  return (
    <section className="card stack">
      <h2>Posting engine</h2>
      <p className="small">
        <a href={status.postizUrl} target="_blank" rel="noreferrer">
          {status.postizUrl}
        </a>{' '}
        <span className="chip published">connected</span>
      </p>
      <p className="muted small">
        Postiz does the actual posting, retries and token refreshes in the background. You never need to open it for the
        networks Fifofarm covers.
      </p>
      {system.postizLogin &&
        (show ? (
          <div className="stack">
            <CopyField label="Postiz login email" value={system.postizLogin.email} />
            <CopyField label="Postiz login password" value={system.postizLogin.password} />
          </div>
        ) : (
          <div className="row">
            <button className="btn link small" onClick={() => setShow(true)}>
              Show the Postiz login (created automatically)
            </button>
          </div>
        ))}
    </section>
  );
}

export function SettingsPage({
  status,
  session,
  onSession,
  onLogout,
  toast,
}: {
  status: Status;
  session: Session;
  onSession: (s: Session) => void;
  onLogout: () => void;
  toast: (m: string) => void;
}) {
  const user = session.user!;
  const isOwner = user.role === 'owner';
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSystem = useCallback(() => {
    api
      .system()
      .then(setSystem)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isOwner) return;
    api
      .preferences()
      .then(setPrefs)
      .catch((err) => setError(err.message));
    loadSystem();
  }, [loadSystem, isOwner]);

  async function save(patch: Partial<Preferences>) {
    setPrefs((p) => (p ? { ...p, ...patch } : p));
    try {
      setPrefs(await api.savePreferences(patch));
      toast('Saved');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const signOut = (
    <section className="card">
      <div className="row">
        <span className="muted small">Signed in as {user.email || user.name}</span>
        <span className="spacer" />
        <button className="btn" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </section>
  );

  if (!isOwner) {
    return (
      <div>
        <h1>Settings</h1>
        <ProfileCard user={user} onSession={onSession} toast={toast} />
        <PasswordCard toast={toast} />
        <section className="card">
          <p className="muted small" style={{ margin: 0 }}>
            Posting settings (caption shortening, YouTube visibility, TikTok privacy, who can reply on X) are the same for
            the whole team and are set by the owner of this {status.brand}.
          </p>
        </section>
        {signOut}
      </div>
    );
  }

  if (!prefs) return <p className="muted">{error ?? 'Loading…'}</p>;

  return (
    <div>
      <h1>Settings</h1>
      {error && <div className="notice error">{error}</div>}

      <ProfileCard user={user} onSession={onSession} toast={toast} />
      <PasswordCard toast={toast} />
      <TeamCard me={user} toast={toast} />
      {system && <SystemCard system={system} onReload={loadSystem} toast={toast} />}
      {system && <DomainCard system={system} />}

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

      {system && <EngineCard system={system} status={status} />}

      {signOut}
    </div>
  );
}
