// ---- The app, models and folders ----

export type FolderKind = 'references' | 'photos' | 'found' | 'generated' | 'edited';

export interface Model {
  id: string;
  name: string;
  color: string;
  position: number;
  notes: string;
  createdAt: string;
  folders: Record<FolderKind, string>;
}

export type EngineState = 'ok' | 'not-connected' | 'bad-key' | 'unreachable';

export interface AppStatus {
  brand: string;
  version: string;
  build: string;
  updateAvailable: boolean;
  engine: { url: string; configured: boolean; state: EngineState; detail?: string };
  studio: { connected: boolean; hasKey?: boolean; needsWorkspace?: boolean; region: string };
  sharing?: { enabled: boolean; host: string };
  activeModel: string;
}

// ---- Sharing (who's signed in, and the people the owner has invited) ----

export type Role = 'owner' | 'guest';

export interface Me {
  user: { id: string; username: string; name: string; role: Role };
  local: boolean; // true when you're on this Mac (localhost) — always the owner, no login
  canManage: boolean; // owner-only things: keys, models, people, sharing
  models: string[] | null; // the model ids this person may use, or null for all of them
}

export interface Person {
  id: string;
  username: string;
  name: string;
  role: Role;
  createdAt: string;
  models: string[];
  modelNames: string[];
}

export interface AppSettings {
  engineUrl: string;
  engineKey: string;
  alibabaKey: string;
  alibabaRegion: string;
  alibabaWorkspace: string;
}

export interface LibraryItem {
  path: string;
  name: string;
  folder: string;
  kind: 'video' | 'image';
  size: number;
  modified: number;
}

export interface LibraryFolder {
  folder: string;
  connected: boolean;
  exists: boolean;
  items: LibraryItem[];
}

export type Library = Record<FolderKind, LibraryFolder>;

// ---- Fifofarm (posting) ----

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

export interface LabeledAccount extends Account {
  modelId: string | null;
  modelName: string | null;
}

export interface Platform {
  identifier: string;
  name: string;
  connect: 'oauth' | 'credentials';
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
  sourcePath?: string;
}

export interface MediaJob {
  id: string;
  name: string;
  status: 'processing' | 'ready' | 'failed';
  step: string;
  progress: number;
  error: string | null;
  result: MediaResult | null;
  source?: 'upload' | 'library';
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
  modelId?: string;
}

// ---- Analytics ----

export type VideoStatus = 'ok' | 'waiting' | 'no-data' | 'unsupported' | 'unavailable' | 'failed' | 'gone' | 'error';

export interface AnalyticsVideo {
  postId: string;
  batchId: string;
  accountId: string;
  accountName: string;
  identifier: string;
  platform: string;
  picture: string | null;
  caption: string;
  title: string;
  previewUrl: string | null;
  kind: 'video' | 'images' | null;
  postedAt: string | null;
  published: boolean;
  url: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
  status: VideoStatus;
  error: string | null;
  fetchedAt: string | null;
  sourcePath?: string | null;
}

export interface NetworkMetric {
  key: string;
  label: string;
  kind: 'daily' | 'total';
  value: number;
  change: number | null;
  points: { day: string; value: number }[];
}

export interface AnalyticsAccount {
  id: string;
  name: string;
  identifier: string;
  platform: string;
  picture: string | null;
  profile: string | null;
  ownerId: string | null;
  ownerName: string | null;
  supported: boolean;
  videos: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  avgViews: number;
  bestPostId: string | null;
  network: NetworkMetric[];
  networkCheckedAt: string | null;
  networkError: string | null;
}

export interface AnalyticsTotals {
  videos: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
}

export interface AnalyticsOverview {
  days: number;
  generatedAt: string;
  lastCheckedAt: string | null;
  totals: AnalyticsTotals;
  daily: { day: string; views: number }[];
  accounts: AnalyticsAccount[];
  videos: AnalyticsVideo[];
}

export interface VideoDetail {
  video: AnalyticsVideo;
  metrics: { label: string; value: number }[];
  history: { day: string; views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; reach: number | null }[];
  siblings: AnalyticsVideo[];
}

// ---- Reel Finder ----

export type ReelPlatform = 'tiktok' | 'instagram' | 'pinterest';

export interface HuntSettings {
  settings_version: number;
  description: string;
  keywords: string;
  exclude: string;
  platforms: ReelPlatform[];
  target_count: number;
  pool_size: number;
  agents: number;
  time_limit_min: number;
  min_duration: number;
  max_duration: number;
  min_views: number;
  min_likes: number;
  max_age_days: number;
  min_score: number;
  closeness: number;
  include_images: boolean;
  model: string;
  watch_check: boolean;
  show_browser: boolean;
  output_dir: string;
  subfolder_per_hunt: boolean;
}

export interface ReelsStatus {
  version: string;
  os: string;
  ollama: { running: boolean; models: { name: string; vision: boolean }[]; installed: boolean; pulling: boolean };
  ffmpeg: boolean;
  similarity: { installed: boolean; ready: boolean; downloaded: boolean; error: string | null };
  logins: Record<ReelPlatform, boolean>;
  browserOpen: boolean;
  hunting: boolean;
  huntModel: string | null;
  testing: boolean;
  canImportLogins: boolean;
}

export interface Reference {
  id: string;
  source: 'file' | 'link';
  name: string;
  url: string;
  kind: 'video' | 'image';
  status: 'analyzing' | 'ready' | 'failed';
  step: string;
  error: string;
  note: string;
  caption: string;
  author: string;
  platform: string;
  duration: number | null;
  description: string;
  queries: string[];
  hashtags: string[];
  tags: string[];
  frames: number;
  looks: boolean;
  created: number;
  uploading?: boolean;
}

export interface Candidate {
  platform: string;
  id: string;
  url: string;
  kind: string;
  caption: string;
  author: string;
  views: number | null;
  likes: number | null;
  duration: number | null;
  timestamp: number | null;
  thumbnail_url: string | null;
  status: string;
  score: number | null;
  reason: string;
  quick: boolean;
  ai_score: number | null;
  look: number | null;
  frames_look: number | null;
  thumb: string | null;
  file: string | null;
}

export interface HuntProgress {
  found: number;
  skipped: number;
  scored: number;
  downloaded: number;
  failed: number;
  already_have: number;
  phase: string;
  target: number;
  pool_target: number;
  looked_at: number;
  queued: number;
  downloading: number;
  elapsed: number;
  folder: string;
  brain: string;
  quick: boolean;
  running: boolean;
  finishing: boolean;
  finished_reason: string;
  references: number;
  matching_looks: boolean;
  closeness: string;
}

export interface Agent {
  id: number;
  platform: string;
  state: string;
  query: string;
  found: number;
  scrolls: number;
  note: string;
}

// A model's latest hunt, as the page gets it when it opens (or over the live connection).
export interface HuntSnapshot {
  progress: HuntProgress;
  agents: Agent[];
  candidates: Candidate[];
  logs: LogEntry[];
}

export interface LogEntry {
  t: number;
  level: string;
  text: string;
}

export interface SelfTestStep {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip' | 'pending' | 'running';
  detail: string;
}

export interface SelfTestState {
  platform: ReelPlatform;
  query: string;
  running: boolean;
  steps: SelfTestStep[];
}

// ---- AI Studio ----

export interface ModelStudioKey {
  hasOwnKey: boolean; // this model has its own key (not the shared default)
  usingDefault: boolean;
  keyMasked: string; // the key is only ever shown masked
  region: string;
  workspace: string;
  defaultConnected: boolean; // is the shared default key usable?
}

export interface StudioOptions {
  connected: boolean;
  needsWorkspace?: boolean;
  models: { id: string; name: string }[];
  modes: { id: 'text' | 'image' | 'reference'; name: string }[];
  resolutions: string[];
  ratios: string[];
  regions: { id: string; name: string }[];
  workspaceRequired?: boolean;
  minDuration: number;
  maxDuration: number;
  estimateSeconds: number;
  maxPhotos: number;
  maxVideos: number;
  referenceSeconds: number;
  currency: string;
  rates: Record<string, Record<string, number>>;
}

export interface StudioSpending {
  currency: string;
  total: number;
  videos: number;
  seconds: number;
  perResolution: Record<string, { videos: number; cost: number; seconds: number }>;
  perMonth: { month: string; videos: number; cost: number }[];
}

export interface StudioJob {
  id: string;
  modelId: string;
  createdAt: string;
  status: string;
  step: string;
  error: string | null;
  taskId: string | null;
  file: string | null;
  mode: 'text' | 'image' | 'reference';
  prompt: string;
  model: string;
  resolution: string;
  ratio: string;
  duration: number; // -1 = Wan picks the length
  audio?: boolean;
  photos: string[];
  videos: string[];
  sentPrompt?: string;
  referenceSeconds?: number;
  seconds?: number | null;
  cost?: number | null;
  costCurrency?: string;
}

// ---- Editing ----

export interface EditClip {
  path: string;
  name: string;
  folder: string;
  kind: 'video' | 'image';
  size: number;
  modified: number;
}

export interface EditJob {
  id: string;
  modelId: string;
  createdAt: string;
  status: string; // starting | processing | saved | failed
  step: string;
  progress: number;
  error: string | null;
  file: string | null;
  name: string;
}

// ---- Metadata ----

export interface MetaFile {
  path: string;
  name: string;
  folder: string;
  kind: 'video' | 'image';
  size: number;
  clean: boolean; // already free of camera/AI/location metadata
  tags: string[]; // short labels of what it still carries (e.g. "GPS", "AI tag", "device")
}

export interface MetaResult {
  cleaned: { path: string; name: string }[];
  failed: { path: string; name: string; error: string }[];
}

// ---- Live updates ----

export interface ServerEvent {
  type: string;
  model: string | null;
  data: unknown;
}
