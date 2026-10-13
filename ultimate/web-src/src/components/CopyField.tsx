import { useState } from 'react';
import { copyText } from '../clipboard';

// A value shown in full (so it can also be selected by hand) with a Copy button.
export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      {label && <span className="muted small">{label}</span>}
      <div className="copy-row">
        <code className="copy-value">{value}</code>
        <button
          type="button"
          className="btn small"
          onClick={async () => {
            if (await copyText(value)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

