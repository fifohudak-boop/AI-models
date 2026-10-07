export type PostizState = 'ok' | 'no-key' | 'bad-key' | 'unreachable';

export interface Status {
  brand: string;
  postiz: PostizState;
  postizUrl: string;
  apiKeyFromEnv: boolean;
  autoSetup: 'idle' | 'waiting' | 'done' | 'taken' | 'error';
  worker?: 'ok' | 'down' | 'unknown';
  detail?: string;
}

export interface SetupField {
  env: string;
  label: string;
  secret: boolean;
  placeholder: string;
  filled: boolean;
}

export interface NetworkSetup {
  id: string;
  title: string;
  platforms: string[];
  console: { label: string; url: string };
  steps: string[];
  notes: string[];
  verification: boolean;
  redirectUrls: string[];
  verificationPrefix: string | null;
  legal: { terms: string; privacy: string } | null;
  fields: SetupField[];
  configured: boolean;
}

export interface ApplyState {
  state: 'running' | 'done' | 'failed';
  at: string;
  message: string;
  keys: string;
}

export interface NetworksInfo {
  setups: NetworkSetup[];
  verificationFiles: string[];
  autoApply: boolean;
  pending: boolean;
  apply: ApplyState | null;
}

export interface UpdateState {
  state: 'ok' | 'updating' | 'failed' | 'offline' | 'off' | '';
  message: string;
  branch: string;
  commit: string;
  commitDate: string;
  subject: string;
  checkedAt: string;
  installedAt: string;
  heartbeatAt: string;
  autoUpdate: boolean;
}

export interface SystemInfo {
  brand: string;
  host: {
    available: boolean;
    helperActive: boolean;
    pending: boolean;
    apply: ApplyState | null;
    update: UpdateState | null;
  };
  domains: {
    serverMode: boolean;
    dashboard: string;
    postiz: string;
    dashboardUrl: string;
    postizUrl: string;
  };
  postizLogin: { email: string; password: string } | null;
}

export interface Account {
  id: string;
  name: string;
  identifier: string;
  picture: string | null;
  profile: string | null;
  disabled: boolean;
  platform: string;
  supported: boolean;
  maxLength: number;
}

export interface Platform {
  identifier: string;
  name: string;
  connect: 'oauth' | 'credentials';
  configured: boolean;
  missingKeys: string[];
}

export interface Preferences {
  youtubeVisibility: 'public' | 'unlisted' | 'private';
  tiktokPrivacy: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
  tiktokAllowComments: boolean;
  tiktokAllowDuet: boolean;
  tiktokAllowStitch: boolean;
  tiktokMode: 'DIRECT_POST' | 'UPLOAD';
  xWhoCanReply: 'everyone' | 'following' | 'mentionedUsers' | 'subscribers' | 'verified';
  autoShorten: boolean;
  pinterestBoards: Record<string, string>;
}

export interface AccountPreview {
  length: number;
  max: number;
  over: boolean;
  willShorten: boolean;
  problems: string[];
  warnings: string[];
}

export interface MediaResult {
  kind: 'video' | 'images';
  name: string;
  previewUrl: string;
  durationSeconds?: number;
  width: number;
  height: number;
  sizeBytes: number;
  reencoded?: boolean;
}

export interface MediaJob {
  id: string;
  name: string;
  status: 'processing' | 'ready' | 'failed';
  step: string;
  progress: number;
  error: string | null;
  result: MediaResult | null;
}

export type ItemState = 'posting' | 'scheduled' | 'published' | 'failed' | 'deleted' | 'draft';

export interface BatchItem {
  accountId: string;
  accountName: string;
  identifier: string;
  platform: string;
  picture: string | null;
  postId: string | null;
  shortened: boolean;
  state: ItemState;
  url?: string | null;
  error?: string;
}

export interface Batch {
  id: string;
  createdAt: string;
  caption: string;
  title: string;
  scheduleAt: string | null;
  media: MediaResult | null;
  items: BatchItem[];
  counts: Partial<Record<ItemState, number>>;
}
