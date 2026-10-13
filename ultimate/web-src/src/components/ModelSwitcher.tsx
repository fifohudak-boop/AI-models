import { useEffect, useRef, useState } from 'react';
import type { Model } from '../types';
import { initialsOf } from '../format';

export function ModelAvatar({ model, size = 28 }: { model: Pick<Model, 'name' | 'color'>; size?: number }) {
  return (
    <span
      className="model-avatar"
      style={{ background: model.color, width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {initialsOf(model.name)}
    </span>
  );
}

// Which model you're working on. Everything below the top bar — Fifofarm, Reel Finder,
// AI Studio, the library — is that model's.
export function ModelSwitcher({
  models,
  current,
  onSelect,
  onCreate,
  onManage,
  hunting,
}: {
  models: Model[];
  current: Model;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  onManage: () => void;
  hunting: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setAdding(false);
      setName('');
      setError(null);
    }
  }, [open]);

  return (
    <div className="model-switcher" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className="model-chip"
        aria-expanded={open}
        aria-controls="model-menu"
        aria-label={`Model: ${current.name}. Switch model`}
        onClick={() => setOpen((o) => !o)}
      >
        <ModelAvatar model={current} />
        <span className="model-chip-name">{current.name}</span>
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="model-menu" id="model-menu">
          <div className="muted small model-menu-title">Your models</div>
          <div className="model-menu-list">
            {models.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`model-option${m.id === current.id ? ' active' : ''}`}
                onClick={() => {
                  onSelect(m.id);
                  setOpen(false);
                }}
              >
                <ModelAvatar model={m} size={26} />
                <span className="model-option-name">{m.name}</span>
                {hunting === m.id && <span className="chip posting">hunting</span>}
                {m.id === current.id && (
                  <span className="check-mark" aria-label="current">
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
          {adding ? (
            <form
              className="stack model-new"
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                try {
                  await onCreate(name);
                  setOpen(false);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <input
                type="text"
                autoFocus
                placeholder="Model name, e.g. Mia"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="New model name"
              />
              {error && <div className="notice error small">{error}</div>}
              <div className="row">
                <button className="btn primary small" disabled={!name.trim()}>
                  Add model
                </button>
                <button type="button" className="btn small" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="row model-menu-actions">
              <button type="button" className="btn small" onClick={() => setAdding(true)}>
                + New model
              </button>
              <span className="spacer" />
              <button
                type="button"
                className="btn link small"
                onClick={() => {
                  setOpen(false);
                  onManage();
                }}
              >
                Manage models
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
