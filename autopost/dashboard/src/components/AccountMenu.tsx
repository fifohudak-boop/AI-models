import { useEffect, useRef, useState } from 'react';
import type { User } from '../types';
import { initialsOf } from '../format';

// Who is signed in, always visible in the top bar, so nobody mistakes someone
// else's account (on a shared computer, say) for their own.
export function AccountMenu({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const isOwner = user.role === 'owner';

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

  return (
    <div className="account-menu" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className="account-chip"
        aria-expanded={open}
        aria-controls="account-popover"
        aria-label={`Signed in as ${user.name}. Open account menu`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="me-avatar" aria-hidden="true">
          {initialsOf(user.name)}
        </span>
        <span className="account-chip-name">{user.name}</span>
      </button>
      {open && (
        <div className="account-popover" id="account-popover">
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <span className="me-avatar big" aria-hidden="true">
              {initialsOf(user.name)}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="account-popover-name">{user.name}</div>
              <div className="muted small account-popover-email">{user.email ?? 'No email yet'}</div>
            </div>
          </div>
          <p className="small" style={{ margin: '12px 0' }}>
            <span className={`chip ${isOwner ? 'published' : 'member'}`}>{isOwner ? 'owner' : 'team member'}</span>{' '}
            <span className="muted">
              {isOwner
                ? "You see everyone's accounts and posts."
                : 'Your own account: your accounts, posts and analytics are yours (the owner can see them too).'}
            </span>
          </p>
          <div className="row">
            <a className="btn small" href="#/settings" onClick={() => setOpen(false)}>
              Your account
            </a>
            <span className="spacer" />
            <button
              type="button"
              className="btn small"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
