import type { ReactNode } from 'react';
import { useEffect } from 'react';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ title, onClose, children, footer }: DialogProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="ca-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ca-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="ca-dialog-header">
          <span className="heading">{title}</span>
          <button type="button" className="ca-icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="ca-dialog-body">{children}</div>
        {footer && <div className="ca-dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}
