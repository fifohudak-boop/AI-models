import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppStatus, Model, ReelsStatus } from './types';
import { api } from './api';
import { BRAND } from './brand';
import { connectLive, useLive } from './live';
import { SYSTEMS, ALL_TABS } from './systems';
import { ModelSwitcher } from './components/ModelSwitcher';
import { SystemNav } from './components/SystemNav';
import { EngineSetup } from './components/EngineSetup';
import { ComposePage } from './pages/ComposePage';
import { AccountsPage } from './pages/AccountsPage';
import { HistoryPage } from './pages/HistoryPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { ReelFinderPage } from './pages/ReelFinderPage';
import { StudioPage } from './pages/StudioPage';
import { SpendingPage } from './pages/SpendingPage';
import { EditPage } from './pages/EditPage';
import { MetadataPage } from './pages/MetadataPage';
import { LibraryPage } from './pages/LibraryPage';
import { SettingsPage } from './pages/SettingsPage';
import { WelcomePage } from './pages/WelcomePage';

export type Tab =
  | 'post'
  | 'accounts'
  | 'history'
  | 'analytics'
  | 'reels'
  | 'reels-library'
  | 'studio'
  | 'studio-library'
  | 'studio-spending'
  | 'edit'
  | 'meta'
  | 'settings';

const FIFOFARM_TABS: Tab[] = ['post', 'accounts', 'history', 'analytics'];
const WIDE_TABS: Tab[] = ['reels', 'reels-library', 'studio-library', 'edit'];
const MODEL_KEY = 'ultimate.model';

function tabFromHash(): Tab {
  const id = window.location.hash.replace(/^#\/?/, '').split('?')[0] as Tab;
  return ALL_TABS.includes(id) ? id : 'post';
}

function rememberedModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) ?? '';
  } catch {
    return '';
  }
}

// Something one tool hands to another: "post this file", "use this as a reference", "edit this"…
export interface Handoff {
  kind: 'post' | 'studio-video' | 'studio-photo' | 'edit';
  path: string;
  at: number;
}

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [models, setModels] = useState<Model[] | null>(null);
  const [modelId, setModelId] = useState<string>(rememberedModel);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [reels, setReels] = useState<ReelsStatus | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const toast = useCallback((message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage((current) => (current === message ? null : current)), 3500);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      setModels(await api.models());
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  const loadReels = useCallback(async () => {
    try {
      setReels(await api.reelsStatus());
    } catch {
      // the app is restarting
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadModels();
    loadReels();
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    const timer = setInterval(() => {
      loadStatus();
      loadReels();
    }, 30_000);
    return () => {
      window.removeEventListener('hashchange', onHash);
      clearInterval(timer);
    };
  }, [loadStatus, loadModels, loadReels]);

  // The model on screen: the one you picked last on this Mac, else the app's last one, else the first.
  const model = useMemo(() => {
    if (!models || models.length === 0) return null;
    return (
      models.find((x) => x.id === modelId) ??
      models.find((x) => x.id === status?.activeModel) ??
      models[0]
    );
  }, [models, modelId, status?.activeModel]);

  useEffect(() => {
    if (!model) return;
    connectLive(model.id);
    try {
      localStorage.setItem(MODEL_KEY, model.id);
    } catch {
      // private mode
    }
    if (document.title !== `${model.name} · ${status?.brand || BRAND.name}`) {
      document.title = `${model.name} · ${status?.brand || BRAND.name}`;
    }
  }, [model, status?.brand]);

  // Keep the hunt indicator current without waiting for the 30-second check.
  useLive((event) => {
    if (event.type === 'finished' || event.type === 'connected') loadReels();
    if (event.type === 'progress' && !reels?.hunting) loadReels();
  });

  const go = useCallback((next: Tab) => {
    window.location.hash = `/${next}`;
  }, []);

  const selectModel = useCallback((id: string) => {
    setModelId(id);
    api.setActiveModel(id).catch(() => {});
  }, []);

  const createModel = useCallback(
    async (name: string) => {
      const created = await api.createModel(name);
      setModels((list) => [...(list ?? []), created]);
      selectModel(created.id);
      toast(`Added ${created.name}`);
    },
    [selectModel, toast]
  );

  const handOff = useCallback(
    (kind: Handoff['kind'], path: string) => {
      setHandoff({ kind, path, at: Date.now() });
      go(kind === 'post' ? 'post' : kind === 'edit' ? 'edit' : 'studio');
    },
    [go]
  );

  if (loadError && !status) {
    return (
      <div className="center-page">
        <div className="card stack">
          <h1>{BRAND.name}</h1>
          <div className="notice error">{loadError}</div>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!status || !models) return <div className="center-page muted">Loading…</div>;
  const brand = status.brand || BRAND.name;
  if (!model) return <WelcomePage brand={brand} onCreate={createModel} />;

  const engineOk = status.engine.state === 'ok';
  const needsEngine = FIFOFARM_TABS.includes(tab) && !engineOk;
  const huntingModel = reels?.hunting ? reels.huntModel : null;
  const huntingName = huntingModel ? models.find((x) => x.id === huntingModel)?.name : null;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <img className="brand-logo" src="/icon.svg" alt="" />
            <span className="brand-name">{brand}</span>
            <span
              className={`brand-dot${engineOk ? '' : ' down'}`}
              title={engineOk ? 'Posting engine connected' : 'Posting engine not connected'}
            />
          </div>
          <ModelSwitcher
            models={models}
            current={model}
            onSelect={selectModel}
            onCreate={createModel}
            onManage={() => go('settings')}
            hunting={huntingModel}
          />
          <SystemNav systems={SYSTEMS} current={tab} huntingName={huntingModel ? huntingName ?? null : null} onNavigate={go} />
        </div>
      </header>
      <main className={WIDE_TABS.includes(tab) ? 'wide' : ''}>
        {status.updateAvailable && (
          <div className="notice info small" style={{ marginBottom: 16 }}>
            A new version of {brand} is ready — quit and reopen the app to install it.
          </div>
        )}
        {huntingModel && huntingModel !== model.id && (
          <div className="notice info small row" style={{ marginBottom: 16 }}>
            <span>Reel Finder is hunting for {huntingName} right now.</span>
            <span className="spacer" />
            <button
              className="btn small"
              onClick={() => {
                selectModel(huntingModel);
                go('reels');
              }}
            >
              Show it
            </button>
          </div>
        )}
        {needsEngine ? (
          <EngineSetup status={status} onDone={loadStatus} toast={toast} />
        ) : (
          <>
            {tab === 'post' && (
              <ComposePage
                key={model.id}
                model={model}
                handoff={handoff?.kind === 'post' ? handoff : null}
                onGoAccounts={() => go('accounts')}
                onGoLibrary={() => go('reels-library')}
              />
            )}
            {tab === 'accounts' && <AccountsPage key={model.id} model={model} models={models} toast={toast} />}
            {tab === 'history' && <HistoryPage key={model.id} model={model} />}
            {tab === 'analytics' && <AnalyticsPage key={model.id} model={model} />}
          </>
        )}
        {tab === 'reels' && (
          <ReelFinderPage
            key={model.id}
            model={model}
            status={reels}
            onStatus={loadReels}
            toast={toast}
            onPost={(path) => handOff('post', path)}
            onStudio={(path) => handOff('studio-video', path)}
            onSettings={() => go('settings')}
          />
        )}
        {tab === 'studio' && (
          <StudioPage
            key={model.id}
            model={model}
            connected={status.studio.connected}
            handoff={handoff?.kind.startsWith('studio') ? handoff : null}
            toast={toast}
            onPost={(path) => handOff('post', path)}
            onSettings={() => go('settings')}
          />
        )}
        {tab === 'studio-spending' && <SpendingPage key={model.id} model={model} onSettings={() => go('settings')} />}
        {tab === 'edit' && (
          <EditPage
            key={model.id}
            model={model}
            handoff={handoff?.kind === 'edit' ? handoff : null}
            toast={toast}
            onPost={(path) => handOff('post', path)}
            onSettings={() => go('settings')}
          />
        )}
        {tab === 'meta' && <MetadataPage key={model.id} model={model} toast={toast} onSettings={() => go('settings')} />}
        {(tab === 'reels-library' || tab === 'studio-library') && (
          <LibraryPage
            key={`${model.id}-${tab}`}
            model={model}
            initialKind={tab === 'studio-library' ? 'generated' : 'found'}
            toast={toast}
            onPost={(path) => handOff('post', path)}
            onStudio={(kind, path) => handOff(kind, path)}
            onEdit={(path) => handOff('edit', path)}
            onReference={async (path) => {
              await api.addReferenceLocal(model.id, path);
              toast('Added as a reference for Reel Finder');
            }}
            onSettings={() => go('settings')}
          />
        )}
        {tab === 'settings' && (
          <SettingsPage
            status={status}
            models={models}
            current={model}
            toast={toast}
            onStatus={loadStatus}
            onModels={(list) => setModels(list)}
            onSelectModel={selectModel}
            onCreateModel={createModel}
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
