import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AnalyticsAccount,
  AnalyticsOverview,
  AnalyticsVideo,
  NetworkMetric,
  TeamUser,
  User,
  VideoDetail,
  VideoStatus,
} from '../types';
import { api } from '../api';
import { AccountAvatar } from '../components/AccountAvatar';
import { ColumnChart, LineChart, Sparkline, TableView } from '../components/charts';
import { formatCount, formatDay, formatHour, formatSigned, formatWhen, timeAgo } from '../format';

const PERIODS = [7, 30, 90] as const;
type Sort = 'newest' | 'views' | 'likes';

const STATUS_TEXT: Record<VideoStatus, string> = {
  ok: '',
  waiting: 'Waiting for its first numbers',
  'no-data': 'No numbers yet — networks take a little while',
  unsupported: "This network doesn't share numbers",
  unavailable: 'Numbers not available for this post',
  failed: 'Post failed',
  gone: 'Removed',
  error: "Couldn't load numbers right now",
};

const METRIC_LABELS: ['views' | 'likes' | 'comments' | 'shares' | 'saves', string][] = [
  ['views', 'views'],
  ['likes', 'likes'],
  ['comments', 'comments'],
  ['shares', 'shares'],
  ['saves', 'saves'],
];

function plural(n: number, word: string) {
  return `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;
}

// Networks name their account numbers in their own way; these read better.
const FRIENDLY: Record<string, string> = {
  followers: 'Followers',
  follower_count: 'New followers',
  following: 'Following',
  subscribers_gained: 'New subscribers',
  subscribers_lost: 'Lost subscribers',
  total_likes: 'Total likes',
  estimated_minutes_watched: 'Minutes watched',
  average_view_duration: 'Avg. seconds watched',
  average_view_percentage: 'Avg. % watched',
};
const FIRST = ['followers', 'follower_count', 'subscribers_gained', 'reach', 'views', 'impressions', 'total_likes', 'likes'];
const rank = (key: string) => (FIRST.includes(key) ? FIRST.indexOf(key) : FIRST.length);

function friendlyMetrics(list: NetworkMetric[]) {
  return [...list]
    .map((m) => ({ ...m, label: FRIENDLY[m.key] ?? m.label }))
    .sort((a, b) => rank(a.key) - rank(b.key));
}

// Axis ticks: 0 · 500 · 2.5K · 10K
function formatTick(n: number) {
  return n >= 1000 ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : formatCount(n);
}

const PAGE = 10;

function Kpi({ label, value, trend }: { label: string; value: number; trend?: number[] }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{formatCount(value)}</span>
      {trend && <Sparkline values={trend} label={`${label} per day`} />}
    </div>
  );
}

function NetworkTile({ metric, days }: { metric: NetworkMetric; days: number }) {
  const total = metric.kind === 'total';
  return (
    <div className="kpi small-kpi">
      <span className="kpi-label">{metric.label}</span>
      <span className="kpi-value">{formatCount(metric.value)}</span>
      <span className="muted small">
        {total
          ? metric.change !== null
            ? `${formatSigned(metric.change)} in ${days} days`
            : 'right now'
          : metric.key.startsWith('average')
            ? `average, last ${days} days`
            : `last ${days} days`}
      </span>
      <Sparkline values={metric.points.map((p) => p.value)} label={`${metric.label} over time`} />
    </div>
  );
}

function numbersLine(v: AnalyticsVideo) {
  return METRIC_LABELS.filter(([key]) => v[key] !== null)
    .map(([key, word]) => `${formatCount(v[key] as number)} ${word}`)
    .join(' · ');
}

function VideoDetailPanel({ postId }: { postId: string }) {
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .analyticsVideo(postId)
      .then(setDetail)
      .catch((err) => setError(err.message));
  }, [postId]);
  if (error) return <div className="notice error small">{error}</div>;
  if (!detail) return <p className="muted small">Loading…</p>;
  const history = detail.history.filter((h) => h.views !== null);
  return (
    <div className="video-detail stack">
      {history.length > 1 ? (
        <>
          <h3>Views since posting</h3>
          <LineChart
            ariaLabel={`Views of this post from ${formatDay(history[0].day)} to ${formatDay(history[history.length - 1].day)}`}
            format={formatCount}
            tickFormat={formatTick}
            points={history.map((h) => ({
              key: h.day,
              t: Date.parse(`${h.day}T12:00:00Z`),
              label: formatDay(h.day),
              value: h.views ?? 0,
              lines: [formatDay(h.day, true), ...(h.likes !== null ? [`${formatCount(h.likes)} likes`] : [])],
            }))}
          />
          <TableView
            caption="Numbers per day"
            head={['Day', 'Views', 'Likes', 'Comments', 'Shares']}
            rows={history.map((h) => [formatDay(h.day), formatCount(h.views), formatCount(h.likes), formatCount(h.comments), formatCount(h.shares)])}
          />
        </>
      ) : (
        <p className="muted small">The growth chart appears after the numbers have been checked on two different days.</p>
      )}
      {detail.metrics.length > 0 && (
        <div className="metric-list">
          {detail.metrics.map((m) => (
            <span key={m.label} className="metric">
              <strong>{formatCount(m.value)}</strong> {m.label.toLowerCase()}
            </span>
          ))}
        </div>
      )}
      {detail.siblings.length > 0 && (
        <div className="stack">
          <h3>Same post on your other accounts</h3>
          {detail.siblings.map((s) => (
            <div key={s.postId} className="row small">
              <AccountAvatar name={s.accountName} picture={s.picture} identifier={s.identifier} />
              <span>
                <strong>{s.accountName}</strong> <span className="muted">· {s.platform}</span>
              </span>
              <span className="spacer" />
              <span>{s.views !== null ? plural(s.views, 'view') : STATUS_TEXT[s.status] || '—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VideoRow({ video, open, onToggle }: { video: AnalyticsVideo; open: boolean; onToggle: () => void }) {
  const note = STATUS_TEXT[video.status];
  return (
    <div className={`video-row${open ? ' open' : ''}`}>
      <button className="video-summary" onClick={onToggle} aria-expanded={open}>
        {video.previewUrl ? <img className="video-thumb" src={video.previewUrl} alt="" /> : <span className="video-thumb" />}
        <span className="video-main">
          <span className="video-caption">{video.title || video.caption || <span className="muted">(no caption)</span>}</span>
          <span className="account-meta">
            {video.accountName} · {video.platform}
            {video.postedAt && ` · ${video.published ? '' : 'scheduled '}${formatWhen(video.postedAt)}`}
          </span>
          <span className="video-numbers">
            {video.status === 'ok' || video.views !== null ? numbersLine(video) : <span className="muted">{note}</span>}
          </span>
        </span>
        <span className="video-views">
          <strong>{formatCount(video.views)}</strong>
          <span className="muted small">views</span>
        </span>
      </button>
      {open && (
        <div className="video-open">
          {video.url && (
            <a className="small" href={video.url} target="_blank" rel="noreferrer">
              Open the post ↗
            </a>
          )}
          <VideoDetailPanel postId={video.postId} />
        </div>
      )}
    </div>
  );
}

function AccountCard({
  account,
  videos,
  days,
  showOwner,
}: {
  account: AnalyticsAccount;
  videos: AnalyticsVideo[];
  days: number;
  showOwner: boolean;
}) {
  const [open, setOpen] = useState(false);
  const best = videos.find((v) => v.postId === account.bestPostId);
  const network = friendlyMetrics(account.network);
  const headline = network.slice(0, 2);
  return (
    <div className={`analytics-account${open ? ' open' : ''}`}>
      <button className="video-summary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <AccountAvatar name={account.name} picture={account.picture} identifier={account.identifier} />
        <span className="video-main">
          <span className="account-name">{account.name}</span>
          <span className="account-meta">
            {account.platform}
            {account.profile && ` · @${account.profile}`}
            {showOwner && account.ownerName && ` · ${account.ownerName}`}
          </span>
          <span className="video-numbers">
            {plural(account.videos, 'post')} · {plural(account.views, 'view')}
            {account.videos > 0 && ` · ${formatCount(account.avgViews)} per post`}
            {headline.map((m) => ` · ${formatCount(m.value)} ${m.label.toLowerCase()}`).join('')}
          </span>
        </span>
        <span className="video-views">
          <strong>{formatCount(account.views)}</strong>
          <span className="muted small">views</span>
        </span>
      </button>
      {open && (
        <div className="video-open stack">
          {!account.supported ? (
            <p className="muted small">{account.platform} doesn't share numbers with apps, so only posting works here.</p>
          ) : (
            <>
              {network.length > 0 ? (
                <div className="kpi-row">
                  {network.map((m) => (
                    <NetworkTile key={m.key} metric={m} days={days} />
                  ))}
                </div>
              ) : (
                <p className="muted small">
                  {account.networkError
                    ? `Couldn't load this account's numbers: ${account.networkError}`
                    : 'Account numbers (followers, reach…) appear within a few hours.'}
                </p>
              )}
              {account.networkCheckedAt && (
                <p className="muted small">Account numbers checked {timeAgo(account.networkCheckedAt)}.</p>
              )}
            </>
          )}
          {best && best.views !== null && (
            <p className="small">
              Best post in this period: <strong>{best.title || best.caption.slice(0, 80) || '(no caption)'}</strong> —{' '}
              {plural(best.views, 'view')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function AnalyticsPage({ user }: { user: User }) {
  const isOwner = user.role === 'owner';
  const [days, setDays] = useState<number>(30);
  const [member, setMember] = useState('');
  const [team, setTeam] = useState<TeamUser[]>([]);
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('newest');
  const [openVideo, setOpenVideo] = useState<string | null>(null);
  const [shownPosts, setShownPosts] = useState(PAGE);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        setData(await api.analytics(days, member));
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [days, member]
  );

  useEffect(() => {
    load();
    const handle = setInterval(() => load(true), 60_000);
    return () => clearInterval(handle);
  }, [load]);

  useEffect(() => {
    if (!isOwner) return;
    api
      .team()
      .then((t) => setTeam(t.users))
      .catch(() => {});
  }, [isOwner]);

  async function refresh() {
    setRefreshing(true);
    try {
      setData(await api.refreshAnalytics(days, member));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  const videos = useMemo(() => {
    const list = [...(data?.videos ?? [])];
    if (sort === 'views') list.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
    if (sort === 'likes') list.sort((a, b) => (b.likes ?? -1) - (a.likes ?? -1));
    return list;
  }, [data, sort]);

  // Average views by the hour (your local time) a post went out.
  const byHour = useMemo(() => {
    const withNumbers = (data?.videos ?? []).filter((v) => v.published && v.views !== null && v.postedAt);
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, posts: 0, views: 0 }));
    for (const v of withNumbers) {
      const h = hours[new Date(v.postedAt!).getHours()];
      h.posts += 1;
      h.views += v.views ?? 0;
    }
    return { count: withNumbers.length, hours };
  }, [data]);

  const showOwner = isOwner && team.length > 1 && !member;
  const accounts = useMemo(() => [...(data?.accounts ?? [])].sort((a, b) => b.views - a.views), [data]);
  const labelEvery = days === 7 ? 1 : days === 30 ? 7 : 15;
  const whose = !isOwner ? 'your accounts' : member ? "this person's accounts" : 'all accounts';

  return (
    <div>
      <div className="card-head">
        <h1>Analytics</h1>
        <button className="btn small" onClick={refresh} disabled={refreshing}>
          {refreshing ? 'Checking the networks…' : 'Refresh now'}
        </button>
      </div>

      <div className="filter-row">
        <div className="segmented" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p} className={days === p ? 'on' : ''} onClick={() => setDays(p)} aria-pressed={days === p}>
              {p} days
            </button>
          ))}
        </div>
        {isOwner && team.length > 1 && (
          <select value={member} onChange={(e) => setMember(e.target.value)} aria-label="Whose accounts" className="filter-select">
            <option value="">Everyone's accounts</option>
            {team.map((u) => (
              <option key={u.id} value={u.id}>
                {u.id === user.id ? 'My accounts' : `${u.name}'s accounts`}
              </option>
            ))}
          </select>
        )}
        <span className="muted small">{data && `Numbers checked ${timeAgo(data.lastCheckedAt)}`}</span>
      </div>

      {error && (
        <div className="notice error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      {!data && !error && <p className="muted">Loading…</p>}

      {data && (
        <div className={loading ? 'refetching' : undefined}>
          {data.accounts.length === 0 ? (
            <div className="empty card">
              {isOwner && member ? 'This person has no connected accounts yet.' : 'Connect an account first — its numbers show up here.'}
            </div>
          ) : (
            <>
              <div className="kpi-row card">
                <Kpi label="Views" value={data.totals.views} trend={data.daily.map((d) => d.views)} />
                <Kpi label="Likes" value={data.totals.likes} />
                <Kpi label="Comments" value={data.totals.comments} />
                <Kpi label="Shares" value={data.totals.shares} />
                <Kpi label="Posts" value={data.totals.videos} />
              </div>

              <section className="card">
                <h2>Views per day</h2>
                <p className="muted small">Views the posts gained each day, across {whose}.</p>
                <ColumnChart
                  ariaLabel={`Views per day for the last ${days} days`}
                  format={formatCount}
                  tickFormat={formatTick}
                  labelEvery={labelEvery}
                  data={data.daily.map((d) => ({
                    key: d.day,
                    label: formatDay(d.day),
                    value: d.views,
                    lines: [formatDay(d.day, true)],
                  }))}
                />
                <TableView
                  caption={`Views per day, last ${days} days`}
                  head={['Day', 'Views']}
                  rows={data.daily.map((d) => [formatDay(d.day, true), formatCount(d.views)])}
                />
              </section>

              <section className="card">
                <h2>Accounts</h2>
                <p className="muted small">Click an account for its followers, reach and more, straight from the network.</p>
                <div className="stack">
                  {accounts.map((a) => (
                    <AccountCard
                      key={a.id}
                      account={a}
                      days={days}
                      showOwner={showOwner}
                      videos={data.videos.filter((v) => v.accountId === a.id)}
                    />
                  ))}
                </div>
              </section>

              <section className="card">
                <div className="card-head">
                  <h2>Posts</h2>
                  <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort posts" className="filter-select">
                    <option value="newest">Newest first</option>
                    <option value="views">Most views</option>
                    <option value="likes">Most likes</option>
                  </select>
                </div>
                {videos.length === 0 ? (
                  <p className="muted">
                    Nothing posted in the last {days} days. Post something and its numbers appear here within about an hour.
                  </p>
                ) : (
                  <div className="stack">
                    {videos.slice(0, shownPosts).map((v) => (
                      <VideoRow
                        key={v.postId}
                        video={v}
                        open={openVideo === v.postId}
                        onToggle={() => setOpenVideo(openVideo === v.postId ? null : v.postId)}
                      />
                    ))}
                    {videos.length > shownPosts && (
                      <div className="row">
                        <button className="btn small" onClick={() => setShownPosts((n) => n + PAGE * 2)}>
                          Show more ({videos.length - shownPosts} left)
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </section>

              {byHour.count >= 5 && (
                <section className="card">
                  <h2>Best time to post</h2>
                  <p className="muted small">
                    Average views by the hour a post went out (your time), from {byHour.count} posts in this period.
                  </p>
                  <ColumnChart
                    ariaLabel="Average views by posting hour"
                    format={formatCount}
                    tickFormat={formatTick}
                    labelEvery={3}
                    data={byHour.hours.map((h) => ({
                      key: String(h.hour),
                      label: formatHour(h.hour),
                      value: h.posts ? h.views / h.posts : 0,
                      lines: [
                        `average views · ${formatHour(h.hour)}–${formatHour((h.hour + 1) % 24)}`,
                        h.posts ? plural(h.posts, 'post') : 'no posts at this hour',
                      ],
                    }))}
                  />
                  <TableView
                    caption="Average views by posting hour"
                    head={['Hour', 'Posts', 'Average views']}
                    rows={byHour.hours
                      .filter((h) => h.posts > 0)
                      .map((h) => [formatHour(h.hour), String(h.posts), formatCount(h.views / h.posts)])}
                  />
                </section>
              )}

              <p className="muted small">
                Numbers come from each network: new posts are checked every hour, older ones less often. Some networks
                (Bluesky, Mastodon, LinkedIn profiles) don't share numbers with apps.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
