import type {
  Account,
  AccountPreview,
  AnalyticsOverview,
  AppSettings,
  AppStatus,
  Batch,
  HuntSettings,
  HuntSnapshot,
  LabeledAccount,
  Library,
  Me,
  MediaJob,
  Model,
  ModelStudioKey,
  Person,
  Platform,
  Preferences,
  Reference,
  ReelsStatus,
  SelfTestState,
  StudioJob,
  StudioOptions,
  StudioSpending,
  EditClip,
  EditJob,
  EditOptions,
  MetaFile,
  MetaResult,
  VideoDetail,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Every change goes with this header: other websites can't add it, so they can't poke the app.
const HEADER = { 'X-Ultimate': '1' };

async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? 'GET',
      headers: { ...HEADER, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError("Can't reach Fifofarm Ultimate. Is it still running? (Reopen the app.)", 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? data?.detail ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

const enc = encodeURIComponent;
const m = (model: string) => `/api/m/${enc(model)}`;

export const api = {
  // ---- who's signed in, logging in and out, and (owner) the people you've invited ----
  me: () => request<Me>('/api/auth/me'),
  login: (username: string, password: string) =>
    request<{ user: Me['user'] }>('/api/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  saveSharing: (enabled: boolean, host: string) =>
    request<{ enabled: boolean; host: string }>('/api/sharing', { method: 'PUT', body: { enabled, host } }),
  people: () => request<Person[]>('/api/auth/users'),
  addPerson: (body: { username: string; password: string; name: string; models: string[] }) =>
    request<Person>('/api/auth/users', { method: 'POST', body }),
  setPersonModels: (id: string, models: string[]) =>
    request<Person>(`/api/auth/users/${enc(id)}/models`, { method: 'PUT', body: { models } }),
  resetPersonPassword: (id: string, password: string) =>
    request<{ ok: true }>(`/api/auth/users/${enc(id)}/password`, { method: 'PUT', body: { password } }),
  removePerson: (id: string) => request<{ ok: true }>(`/api/auth/users/${enc(id)}`, { method: 'DELETE' }),

  // ---- app, models, folders ----
  status: () => request<AppStatus>('/api/status'),
  settings: () => request<AppSettings>('/api/settings'),
  connectEngine: (body: { url: string; apiKey?: string; email?: string; password?: string }) =>
    request<AppSettings>('/api/settings/engine', { method: 'PUT', body }),
  disconnectEngine: () => request<AppSettings>('/api/settings/engine', { method: 'DELETE' }),
  // apiKey null keeps the saved key (to change only the region or workspace); '' removes it.
  saveStudioKey: (apiKey: string | null, region: string, workspace: string) =>
    request<AppSettings>('/api/settings/studio', { method: 'PUT', body: { apiKey, region, workspace } }),
  setActiveModel: (id: string) => request<{ ok: true }>('/api/active-model', { method: 'PUT', body: { id } }),

  models: () => request<Model[]>('/api/models'),
  createModel: (name: string) => request<Model>('/api/models', { method: 'POST', body: { name } }),
  updateModel: (id: string, patch: Partial<Pick<Model, 'name' | 'color' | 'notes'>> & { folders?: Partial<Record<string, string>> }) =>
    request<Model>(`/api/models/${enc(id)}`, { method: 'PUT', body: patch }),
  deleteModel: (id: string) => request<{ ok: true }>(`/api/models/${enc(id)}`, { method: 'DELETE' }),
  reorderModels: (ids: string[]) => request<Model[]>('/api/models-order', { method: 'PUT', body: { ids } }),

  pickFolder: (current: string, prompt: string) =>
    request<{ path: string | null }>('/api/pick-folder', { method: 'POST', body: { current, prompt } }),
  openFolder: (path: string) => request<{ path: string }>('/api/open-folder', { method: 'POST', body: { path } }),
  library: (model: string) => request<Library>(`${m(model)}/library`),
  libraryThumb: (model: string, path: string) => `${m(model)}/library/thumb?path=${enc(path)}`,
  libraryFile: (model: string, path: string) => `${m(model)}/library/file?path=${enc(path)}`,

  // ---- Fifofarm ----
  platforms: () => request<Platform[]>('/api/platforms'),
  accounts: (model: string) => request<Account[]>(`${m(model)}/accounts`),
  allAccounts: () => request<LabeledAccount[]>('/api/accounts'),
  moveAccount: (accountId: string, modelId: string | null) =>
    request<LabeledAccount[]>(`/api/accounts/${enc(accountId)}/model`, { method: 'PUT', body: { modelId } }),
  connectUrl: (model: string, provider: string, another = false) =>
    request<{ url: string }>(`${m(model)}/accounts/connect`, { method: 'POST', body: { provider, another } }),
  connectLink: (model: string, provider: string) =>
    request<{ url: string; expiresAt: string }>(`${m(model)}/accounts/connect-link`, { method: 'POST', body: { provider } }),
  connectBluesky: (model: string, handle: string, appPassword: string) =>
    request<{ ok: true }>(`${m(model)}/accounts/bluesky`, { method: 'POST', body: { handle, appPassword } }),
  pinterestBoards: (id: string) => request<{ id: string; name: string }[]>(`/api/accounts/${enc(id)}/boards`),
  preferences: () => request<Preferences>('/api/preferences'),
  savePreferences: (patch: Partial<Preferences>) => request<Preferences>('/api/preferences', { method: 'PUT', body: patch }),

  mediaJob: (id: string) => request<MediaJob>(`/api/media/${enc(id)}`),
  localMedia: (model: string, path: string) =>
    request<MediaJob>(`${m(model)}/media/local`, { method: 'POST', body: { path } }),
  preview: (model: string, body: { caption: string; captions: Record<string, string>; mediaId: string | null }) =>
    request<Record<string, AccountPreview>>(`${m(model)}/preview`, { method: 'POST', body }),
  post: (
    model: string,
    body: {
      caption: string;
      title: string;
      mediaId: string | null;
      accountIds: string[];
      scheduleAt: string | null;
      captions: Record<string, string>;
    }
  ) => request<Batch>(`${m(model)}/posts`, { method: 'POST', body }),
  batches: (model: string) => request<Batch[]>(`${m(model)}/batches`),
  batch: (model: string, id: string) => request<Batch>(`${m(model)}/batches/${enc(id)}`),
  retry: (model: string, id: string) => request<Batch>(`${m(model)}/batches/${enc(id)}/retry`, { method: 'POST' }),
  deleteBatch: (model: string, id: string) => request<{ ok: true }>(`${m(model)}/batches/${enc(id)}`, { method: 'DELETE' }),

  analytics: (model: string, days: number) => request<AnalyticsOverview>(`${m(model)}/analytics?days=${days}`),
  refreshAnalytics: (model: string, days: number) =>
    request<AnalyticsOverview>(`${m(model)}/analytics/refresh?days=${days}`, { method: 'POST' }),
  analyticsVideo: (model: string, postId: string) => request<VideoDetail>(`${m(model)}/analytics/videos/${enc(postId)}`),

  // ---- Reel Finder ----
  reelsStatus: () => request<ReelsStatus>('/api/reels/status'),
  huntSettings: (model: string) => request<HuntSettings>(`${m(model)}/reels/settings`),
  saveHuntSettings: (model: string, settings: HuntSettings) =>
    request<HuntSettings>(`${m(model)}/reels/settings`, { method: 'PUT', body: settings }),
  startHunt: (model: string, settings: HuntSettings) =>
    request<{ ok: true; folder: string }>(`${m(model)}/reels/hunt/start`, {
      method: 'POST',
      body: { settings, screen_w: window.screen.availWidth || 1440, screen_h: window.screen.availHeight || 900 },
    }),
  finishHunt: () => request<{ ok: true }>('/api/reels/hunt/finish', { method: 'POST' }),
  stopHunt: () => request<{ ok: true }>('/api/reels/hunt/stop', { method: 'POST' }),
  reelsLogin: (platform: string) => request<{ ok: true }>(`/api/reels/login/${enc(platform)}`, { method: 'POST' }),
  closeAgentsBrowser: () => request<{ ok: true }>('/api/reels/browser/close', { method: 'POST' }),
  importLogins: () => request<{ ok: true }>('/api/reels/import-logins', { method: 'POST' }),
  pullModel: (model: string) => request<{ ok: true }>('/api/reels/ollama/pull', { method: 'POST', body: { model } }),
  selfTest: (platform: string, settings: HuntSettings) =>
    request<{ ok: true; query: string }>(`/api/reels/selftest/${enc(platform)}`, { method: 'POST', body: { settings } }),
  openLog: () => request<{ path: string }>('/api/reels/open-log', { method: 'POST' }),
  reportUrl: '/api/reels/report',
  references: (model: string) => request<Reference[]>(`${m(model)}/reels/references`),
  addReferenceLink: (model: string, url: string) =>
    request<Reference>(`${m(model)}/reels/references/link`, { method: 'POST', body: { url } }),
  addReferenceLocal: (model: string, path: string) =>
    request<Reference>(`${m(model)}/reels/references/local`, { method: 'POST', body: { path } }),
  removeReference: (model: string, id: string) =>
    request<{ ok: true }>(`${m(model)}/reels/references/${enc(id)}`, { method: 'DELETE' }),
  referenceFrame: (model: string, id: string, n: number) => `${m(model)}/reels/references/${enc(id)}/frame/${n}.jpg`,
  saveLink: (model: string, url: string) => request<{ ok: true }>(`${m(model)}/reels/save-link`, { method: 'POST', body: { url } }),
  thumb: (model: string, name: string) => `${m(model)}/reels/thumbs/${enc(name)}`,
  huntSnapshot: (model: string) => request<{ hunt: HuntSnapshot | null; selftests: SelfTestState[] }>(`${m(model)}/reels/snapshot`),

  // ---- AI Studio ----
  studioOptions: () => request<StudioOptions>('/api/studio/options'),
  modelStudioOptions: (model: string) => request<StudioOptions>(`${m(model)}/studio/options`),
  modelStudioKey: (model: string) => request<ModelStudioKey>(`${m(model)}/studio/key`),
  // apiKey null keeps the saved key; '' removes this model's own key (back to the shared default).
  saveModelStudioKey: (model: string, provider: string, apiKey: string | null, region: string, workspace: string) =>
    request<ModelStudioKey>(`${m(model)}/studio/key`, { method: 'PUT', body: { provider, apiKey, region, workspace } }),
  // The automatic price for one generation with these settings.
  studioPrice: (model: string, genModel: string, resolution: string, seconds: number, images = 1) =>
    request<{ price: number | null; currency: string }>(
      `${m(model)}/studio/price?model=${enc(genModel)}&resolution=${enc(resolution)}&seconds=${seconds}&images=${images}`
    ),
  studioJobs: (model: string) => request<StudioJob[]>(`${m(model)}/studio/jobs`),
  createStudioJob: (model: string, body: Record<string, unknown>) =>
    request<StudioJob>(`${m(model)}/studio/jobs`, { method: 'POST', body }),
  studioSpending: (model: string) => request<StudioSpending>(`${m(model)}/studio/spending`),

  // ---- Editing ----
  editOptions: () => request<EditOptions>('/api/edit/options'),
  editFilmstrip: (model: string, path: string) => `${m(model)}/edit/filmstrip?path=${enc(path)}`,
  editClips: (model: string) => request<EditClip[]>(`${m(model)}/edit/clips`),
  editMusic: (model: string) => request<{ name: string; path: string; size: number }[]>(`${m(model)}/edit/music`),
  createEdit: (model: string, body: Record<string, unknown>) =>
    request<EditJob>(`${m(model)}/edit/jobs`, { method: 'POST', body }),
  editJobs: (model: string) => request<EditJob[]>(`${m(model)}/edit/jobs`),

  // ---- Metadata ----
  metadataFiles: (model: string) => request<MetaFile[]>(`${m(model)}/metadata/files`),
  cleanMetadata: (model: string, paths: string[]) =>
    request<MetaResult>(`${m(model)}/metadata/clean`, { method: 'POST', body: { paths } }),
};

// The file goes as the request body (no form encoding); XHR so big videos show progress.
function sendFile<T>(url: string, file: File, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-Ultimate', '1');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: { error?: string; detail?: string } | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // ignore
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data as T);
      else reject(new ApiError(data?.error ?? data?.detail ?? `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("Upload failed — is Fifofarm Ultimate still running?", 0));
    xhr.send(file);
  });
}

export function uploadMedia(file: File, onProgress: (fraction: number) => void): Promise<MediaJob> {
  return sendFile<MediaJob>(`/api/media?name=${enc(file.name)}`, file, onProgress);
}

export function uploadReference(model: string, file: File): Promise<Reference> {
  return sendFile<Reference>(`${m(model)}/reels/references/upload?name=${enc(file.name)}`, file);
}

export function uploadMusic(model: string, file: File): Promise<{ name: string; path: string; size: number }> {
  return sendFile(`${m(model)}/edit/music?name=${enc(file.name)}`, file);
}
