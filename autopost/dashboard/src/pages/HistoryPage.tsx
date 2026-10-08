import { useCallback, useEffect, useState } from 'react';
import type { Batch, TeamUser, User } from '../types';
import { api } from '../api';
import { BatchCard } from '../components/BatchCard';
import { isActive } from '../batchStatus';

export function HistoryPage({ user }: { user: User }) {
  const isOwner = user.role === 'owner';
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [team, setTeam] = useState<TeamUser[]>([]);
  const [person, setPerson] = useState('');

  const load = useCallback(async () => {
    try {
      setBatches(await api.batches(person));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [person]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!isOwner) return;
    api
      .team()
      .then((t) => setTeam(t.users))
      .catch(() => {});
  }, [isOwner]);

  const anyActive = batches?.some(isActive) ?? false;
  useEffect(() => {
    if (!anyActive) return;
    const handle = setInterval(load, 5000);
    return () => clearInterval(handle);
  }, [anyActive, load]);

  const showAuthor = isOwner && team.length > 1;

  return (
    <div>
      <div className="card-head">
        <h1>History</h1>
        <div className="row">
          {showAuthor && (
            <select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Whose posts">
              <option value="">Everyone's posts</option>
              {team.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.id === user.id ? 'My posts' : `${u.name}'s posts`}
                </option>
              ))}
            </select>
          )}
          <button className="btn small" onClick={load}>
            Refresh
          </button>
        </div>
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
          author={showAuthor ? (b.userId === user.id ? 'you' : b.userName ?? null) : null}
          onChange={(updated) => setBatches((list) => list?.map((x) => (x.id === updated.id ? updated : x)) ?? null)}
          onDeleted={(id) => setBatches((list) => list?.filter((x) => x.id !== id) ?? null)}
        />
      ))}
    </div>
  );
}
