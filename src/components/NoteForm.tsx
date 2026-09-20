import { Button } from './Button';

interface NoteFormProps {
  title: string;
  onTitleChange: (value: string) => void;
  body: string;
  onBodyChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  error?: string | null;
  busy?: boolean;
}

export function NoteForm({ title, onTitleChange, body, onBodyChange, onSave, onCancel, onDelete, error, busy }: NoteFormProps) {
  return (
    <form
      className="ca-event-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <label className="ca-field">
        <span className="caption ca-field-label">Title</span>
        <input
          className="body ca-input"
          type="text"
          value={title}
          placeholder="Untitled note"
          autoFocus
          onChange={(e) => onTitleChange(e.target.value)}
        />
      </label>

      <label className="ca-field">
        <span className="caption ca-field-label">Note</span>
        <textarea className="body ca-input ca-textarea" value={body} rows={8} onChange={(e) => onBodyChange(e.target.value)} />
      </label>

      {error && <p className="caption ca-form-error">{error}</p>}

      <div className="ca-event-form-actions">
        {onDelete ? (
          <Button variant="danger" type="button" onClick={onDelete} disabled={busy}>
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="ca-event-form-actions-right">
          <Button variant="secondary" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save note'}
          </Button>
        </div>
      </div>
    </form>
  );
}
