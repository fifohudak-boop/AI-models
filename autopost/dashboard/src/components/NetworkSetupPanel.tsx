import { useState } from 'react';
import type { NetworkSetup } from '../types';
import { api } from '../api';
import { CopyField } from './CopyField';

// Step-by-step setup of one network's developer app, right in Fifofarm:
// what to click, the exact addresses to paste there, and fields for the keys.
// Saving queues the keys; the server applies them within a minute.
export function NetworkSetupPanel({
  setup,
  verificationFiles,
  autoApply,
  onSaved,
  onVerificationChange,
}: {
  setup: NetworkSetup;
  verificationFiles: string[];
  autoApply: boolean;
  onSaved: (message: string) => void;
  onVerificationChange: (files: string[]) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.saveNetwork(setup.id, values);
      setValues({});
      onSaved(
        res.autoApply
          ? `${setup.title} keys saved. Fifofarm restarts the posting engine with them now — about 1–3 minutes.`
          : `${setup.title} keys saved. They apply the next time the server helper runs.`
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadVerification(file: File) {
    setVerifyError(null);
    try {
      const content = (await file.text()).trim();
      const res = await api.saveVerification(file.name, content);
      onVerificationChange(res.files);
    } catch (err) {
      setVerifyError((err as Error).message);
    }
  }

  const anyValue = Object.values(values).some((v) => v.trim() !== '');

  return (
    <div className="setup-panel stack">
      <div className="row">
        <a className="btn small" href={setup.console.url} target="_blank" rel="noreferrer">
          Open {setup.console.label} ↗
        </a>
        {setup.configured && <span className="chip published">keys saved</span>}
      </div>

      <ol className="setup-steps">
        {setup.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>

      <div className="stack">
        {setup.redirectUrls.map((url) => (
          <CopyField key={url} label="Redirect URL" value={url} />
        ))}
        {setup.legal && setup.id === 'tiktok' && (
          <>
            <CopyField label="Terms of Service URL" value={setup.legal.terms} />
            <CopyField label="Privacy Policy URL" value={setup.legal.privacy} />
          </>
        )}
        {setup.verification && setup.verificationPrefix && (
          <>
            <CopyField label="URL prefix to verify" value={setup.verificationPrefix} />
            <label className="field">
              <span>Verification file (the .txt file TikTok lets you download)</span>
              <input
                type="file"
                accept=".txt,text/plain"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) uploadVerification(file);
                }}
              />
            </label>
            {verifyError && <div className="notice error small">{verifyError}</div>}
            {verificationFiles.length > 0 && (
              <div className="muted small">
                Online now:{' '}
                {verificationFiles.map((name) => (
                  <span key={name} className="verification-file">
                    <a href={`${setup.verificationPrefix}${name}`} target="_blank" rel="noreferrer">
                      {name}
                    </a>{' '}
                    <button
                      type="button"
                      className="btn link small"
                      onClick={async () => onVerificationChange((await api.deleteVerification(name)).files)}
                    >
                      remove
                    </button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {setup.notes.map((note) => (
        <div key={note} className="notice info small">
          {note}
        </div>
      ))}

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {setup.fields.map((f) => (
          <label className="field" key={f.env}>
            <span>
              {f.label}
              {f.filled && <span className="muted small"> · saved (leave empty to keep)</span>}
            </span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={f.filled ? '••••••••' : f.placeholder || `Paste the ${f.label.toLowerCase()}`}
              value={values[f.env] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.env]: e.target.value }))}
            />
          </label>
        ))}
        {error && <div className="notice error small">{error}</div>}
        {!autoApply && (
          <div className="notice warn small">
            Automatic apply isn't switched on for this server yet, so saved keys wait until it is.
          </div>
        )}
        <button className="btn primary" disabled={busy || !anyValue}>
          {busy ? 'Saving…' : 'Save keys'}
        </button>
      </form>
    </div>
  );
}
