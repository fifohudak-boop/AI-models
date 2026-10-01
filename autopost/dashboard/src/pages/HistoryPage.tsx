import { useCallback, useEffect, useState } from 'react';
import type { Batch } from '../types';
import { api } from '../api';
import { BatchCard } from '../components/BatchCard';
import { isActive } from '../batchStatus';

export function HistoryPage() {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBatches(await api.batches());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const anyActive = batches?.some(isActive) ?? false;
  useEffect(() => {
    if (!anyActive) return;
    const handle = setInterval(load, 5000);
    return () => clearInterval(handle);
  }, [anyActive, load]);

  return (
    <div>
      <div className="card-head">
        <h1>History</h1>
        <button className="btn small" onClick={load}>
          Refresh
        </button>
      </div>
      {error && (
        <div className="notice error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      {batches === null && !error && <p className="muted">Loading…</p>}
      {batches?.length === 0 && <div className="empty card">Nothing posted yet.</div>}
      {batches?.map((b) => (
        <BatchCard
          key={b.id}
          batch={b}
          onChange={(updated) => setBatches((list) => list?.map((x) => (x.id === updated.id ? updated : x)) ?? null)}
          onDeleted={(id) => setBatches((list) => list?.filter((x) => x.id !== id) ?? null)}
        />
      ))}
    </div>
  );
}
