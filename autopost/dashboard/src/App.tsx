import { useCallback, useEffect, useState } from 'react';
import type { Status } from './types';
import { api, setUnauthorizedHandler } from './api';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { ComposePage } from './pages/ComposePage';
import { AccountsPage } from './pages/AccountsPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';
import { BRAND } from './brand';

type Tab = 'post' | 'accounts' | 'history' | 'settings';
const TABS: { id: Tab; label: string }[] = [
  { id: 'post', label: 'Post' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

function tabFromHash(): Tab {
  const id = window.location.hash.replace(/^#\/?/, '') as Tab;
  return TABS.some((t) => t.id === id) ? id : 'post';
}

export function App() {
  const [session, setSession] = useState<'unknown' | 'out' | 'in'>('unknown');
  const [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  // Once Postiz has worked, a blip (e.g. a restart) shows a banner instead of
  // throwing you out to the setup screen and losing what you were writing.
  const [everConnected, setEverConnected] = useState(false);

  const toast = useCallback((message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage((current) => (current === message ? null : current)), 3000);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const next = await api.status();
      setStatus(next);
      if (next.postiz === 'ok') setEverConnected(true);
    } catch {
      // 401 is handled by the unauthorized handler
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setSession('out'));
    api
      .session()
      .then((s) => setSession(s.loggedIn ? 'in' : 'out'))
      .catch(() => setSession('out'));
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (session !== 'in') return;
    loadStatus();
    const handle = setInterval(loadStatus, 30_000);
    return () => clearInterval(handle);
  }, [session, loadStatus]);

  if (session === 'unknown') return null;
  if (session === 'out') return <LoginPage onLoggedIn={() => setSession('in')} />;
  if (!status) return <div className="center-page muted">Loading…</div>;
  const brand = status.brand || BRAND.name;
  if (document.title !== brand) document.title = brand;
  const blip = everConnected && status.postiz === 'unreachable';
  if (status.postiz !== 'ok' && !blip) return <SetupPage status={status} onDone={loadStatus} />;
  const engineDown = blip || status.worker === 'down';

  const go = (next: Tab) => {
    window.location.hash = `/${next}`;
  };

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <img className="brand-logo" src="/icon.svg" alt="" />
            {brand}
            <span
              className={`brand-dot${engineDown ? ' down' : ''}`}
              title={engineDown ? 'Posting engine is restarting' : 'Posting engine running'}
            />
          </div>
          <nav className="tabs">
            {TABS.map((t) => (
              <a key={t.id} href={`#/${t.id}`} className={`tab${tab === t.id ? ' active' : ''}`}>
                {t.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main>
        {engineDown && (
          <div className="notice warn" style={{ marginBottom: 16 }}>
            The posting engine isn't picking up posts right now. It restarts itself automatically within a few minutes —
            anything you post meanwhile waits safely in the queue and goes out once it's back.
          </div>
        )}
        {tab === 'post' && <ComposePage onGoAccounts={() => go('accounts')} />}
        {tab === 'accounts' && <AccountsPage postizUrl={status.postizUrl} toast={toast} />}
        {tab === 'history' && <HistoryPage />}
        {tab === 'settings' && (
          <SettingsPage
            status={status}
            toast={toast}
            onLogout={async () => {
              await api.logout().catch(() => {});
              setSession('out');
            }}
          />
        )}
      </main>
      {toastMessage && (
        <div className="toast" role="status">
          {toastMessage}
        </div>
      )}
    </>
  );
}
