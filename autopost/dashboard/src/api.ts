import type {
  Account,
  AccountPreview,
  AnalyticsOverview,
  Batch,
  MediaJob,
  NetworksInfo,
  Platform,
  Preferences,
  Session,
  Status,
  SystemInfo,
  TeamInfo,
  VideoDetail,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Lets the app jump back to the login screen when the session expires.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? 'GET',
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError("Can't reach the dashboard server. Check your connection.", 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') onUnauthorized?.();
    throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

function analyticsQuery(days: number, member: string) {
  const qs = new URLSearchParams({ days: String(days) });
  if (member) qs.set('member', member);
  return qs.toString();
}

export const api = {
  session: () => request<Session>('/api/session'),
  login: (email: string, password: string) =>
    request<Session>('/api/login', { method: 'POST', body: { email, password } }),
  signup: (name: string, email: string, password: string) =>
    request<Session>('/api/signup', { method: 'POST', body: { name, email, password } }),
  logout: () => request<{ loggedIn: boolean }>('/api/logout', { method: 'POST' }),
  updateMe: (patch: { name?: string; email?: string }) => request<Session>('/api/me', { method: 'PUT', body: patch }),

  team: () => request<TeamInfo>('/api/team'),
  setSignups: (open: boolean) => request<{ signupsOpen: boolean }>('/api/team/signups', { method: 'PUT', body: { open } }),
  resetMemberPassword: (id: string) =>
    request<{ password: string }>(`/api/team/${encodeURIComponent(id)}/reset-password`, { method: 'POST' }),
  removeMember: (id: string) => request<{ ok: true }>(`/api/team/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  moveAccount: (accountId: string, userId: string) =>
    request<Account[]>(`/api/accounts/${encodeURIComponent(accountId)}/owner`, { method: 'PUT', body: { userId } }),

  analytics: (days: number, member = '') => request<AnalyticsOverview>(`/api/analytics?${analyticsQuery(days, member)}`),
  refreshAnalytics: (days: number, member = '') =>
    request<AnalyticsOverview>(`/api/analytics/refresh?${analyticsQuery(days, member)}`, { method: 'POST' }),
  analyticsVideo: (postId: string) => request<VideoDetail>(`/api/analytics/videos/${encodeURIComponent(postId)}`),

  status: () => request<Status>('/api/status'),
  saveApiKey: (apiKey: string) => request<{ ok: true }>('/api/settings/api-key', { method: 'PUT', body: { apiKey } }),
  preferences: () => request<Preferences>('/api/preferences'),
  savePreferences: (patch: Partial<Preferences>) =>
    request<Preferences>('/api/preferences', { method: 'PUT', body: patch }),

  autoSetup: () => request<{ phase: Status['autoSetup']; detail: string | null }>('/api/setup/auto', { method: 'POST' }),
  changePassword: (current: string, next: string) =>
    request<{ ok: true }>('/api/settings/password', { method: 'PUT', body: { current, next } }),
  changeDomain: (domain: string) =>
    request<{ ok: true; dashboardUrl: string; postizUrl: string }>('/api/settings/domain', {
      method: 'PUT',
      body: { domain },
    }),
  system: () => request<SystemInfo>('/api/system'),
  checkUpdates: () => request<{ ok: true }>('/api/system/check-updates', { method: 'POST' }),

  networks: () => request<NetworksInfo>('/api/networks'),
  saveNetwork: (id: string, values: Record<string, string>) =>
    request<{ ok: true; autoApply: boolean; keys: string[] }>(`/api/networks/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: { values },
    }),
  saveVerification: (name: string, content: string) =>
    request<{ ok: true; files: string[] }>('/api/verification', { method: 'PUT', body: { name, content } }),
  deleteVerification: (name: string) =>
    request<{ ok: true; files: string[] }>(`/api/verification/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  platforms: () => request<Platform[]>('/api/platforms'),
  accounts: () => request<Account[]>('/api/accounts'),
  connectUrl: (provider: string, another = false) =>
    request<{ url: string }>('/api/accounts/connect', { method: 'POST', body: { provider, another } }),
  connectLink: (provider: string) =>
    request<{ url: string; expiresAt: string }>('/api/accounts/connect-link', { method: 'POST', body: { provider } }),
  connectBluesky: (handle: string, appPassword: string) =>
    request<{ ok: true }>('/api/accounts/bluesky', { method: 'POST', body: { handle, appPassword } }),
  removeAccount: (id: string) => request<{ ok: true }>(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  pinterestBoards: (id: string) =>
    request<{ id: string; name: string }[]>(`/api/accounts/${encodeURIComponent(id)}/boards`),

  mediaJob: (id: string) => request<MediaJob>(`/api/media/${encodeURIComponent(id)}`),

  preview: (body: { caption: string; captions: Record<string, string>; mediaId: string | null }) =>
    request<Record<string, AccountPreview>>('/api/preview', { method: 'POST', body }),

  post: (body: {
    caption: string;
    title: string;
    mediaId: string | null;
    accountIds: string[];
    scheduleAt: string | null;
    captions: Record<string, string>;
  }) => request<Batch>('/api/posts', { method: 'POST', body }),

  batches: (user = '') => request<Batch[]>(`/api/batches${user ? `?user=${encodeURIComponent(user)}` : ''}`),
  batch: (id: string) => request<Batch>(`/api/batches/${encodeURIComponent(id)}`),
  retry: (id: string) => request<Batch>(`/api/batches/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  deleteBatch: (id: string) => request<{ ok: true }>(`/api/batches/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

// XHR instead of fetch so we can show upload progress for big videos.
export function uploadMedia(file: File, onProgress: (fraction: number) => void): Promise<MediaJob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/media');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: { error?: string } | MediaJob | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // ignore
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data as MediaJob);
      else {
        if (xhr.status === 401) onUnauthorized?.();
        reject(new ApiError((data as { error?: string })?.error ?? `Upload failed (${xhr.status})`, xhr.status));
      }
    };
    xhr.onerror = () => reject(new ApiError('Upload failed — check your connection.', 0));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}
