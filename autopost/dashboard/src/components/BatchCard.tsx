import { useState } from 'react';
import type { Batch, BatchItem, ItemState } from '../types';
import { AccountAvatar } from './AccountAvatar';
import { api } from '../api';
import { formatWhen } from '../format';
import { summarize } from '../batchStatus';

const LABELS: Record<ItemState, string> = {
  posting: 'Posting…',
  scheduled: 'Scheduled',
  published: 'Published',
  failed: 'Failed',
  deleted: 'Removed',
  draft: 'Draft',
};

export function StatusChip({ state }: { state: ItemState }) {
  return (
    <span className={`chip ${state}`}>
      {state === 'posting' && <span className="spinner" aria-hidden="true" />}
      {LABELS[state]}
    </span>
  );
}

function ItemRow({ item }: { item: BatchItem }) {
  return (
    <div className="batch-item">
      <AccountAvatar name={item.accountName} picture={item.picture} identifier={item.identifier} />
      <div className="account-main">
        <div className="account-name">{item.accountName}</div>
        <div className="account-meta">
          {item.platform}
          {item.shortened && ' · caption shortened to fit'}
        </div>
        {item.state === 'failed' && item.error && <div className="batch-error">{item.error}</div>}
      </div>
      <div className="account-side stack">
        <StatusChip state={item.state} />
        {item.url && (
          <div>
            <a href={item.url} target="_blank" rel="noreferrer">
              View post ↗
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

export function BatchCard({
  batch,
  author = null,
  onChange,
  onDeleted,
}: {
  batch: Batch;
  author?: string | null;
  onChange: (b: Batch) => void;
  onDeleted: (id: string) => void;
}) {
  const [busy, setBusy] = useState<'retry' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setBusy('retry');
    setError(null);
    try {
      onChange(await api.retry(batch.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const pending = (batch.counts.scheduled ?? 0) + (batch.counts.posting ?? 0);
    const message =
      pending > 0
        ? 'Delete this post? Anything not yet published is cancelled. Already-published posts stay on the networks.'
        : 'Remove this from your history? Published posts stay on the networks.';
    if (!window.confirm(message)) return;
    setBusy('delete');
    setError(null);
    try {
      await api.deleteBatch(batch.id);
      onDeleted(batch.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  const when = batch.scheduleAt ? `Scheduled for ${formatWhen(batch.scheduleAt)}` : `Posted ${formatWhen(batch.createdAt)}`;

  return (
    <article className="card">
      <div className="batch-head">
        {batch.media?.previewUrl && <img src={batch.media.previewUrl} alt="" />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="muted small">
            {when}
            {author && ` by ${author}`} · {summarize(batch)}
          </div>
          {batch.title && <strong>{batch.title}</strong>}
          <div className="batch-caption">{batch.caption || <span className="muted">(no caption)</span>}</div>
        </div>
      </div>
      {batch.items.map((item) => (
        <ItemRow key={item.accountId} item={item} />
      ))}
      {error && <div className="notice error">{error}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        {(batch.counts.failed ?? 0) > 0 && (
          <button className="btn primary small" onClick={retry} disabled={busy !== null}>
            {busy === 'retry' ? 'Retrying…' : `Retry ${batch.counts.failed} failed`}
          </button>
        )}
        <button className="btn danger small" onClick={remove} disabled={busy !== null}>
          {busy === 'delete' ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </article>
  );
}
