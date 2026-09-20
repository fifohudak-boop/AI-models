import { useState } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { NoteForm } from './NoteForm';
import type { Note } from '../types';

interface Draft {
  id?: string;
  title: string;
  body: string;
}

interface NotesPageProps {
  notes: Note[];
  onCreate: (input: { title: string; body: string }) => Promise<void>;
  onUpdate: (id: string, input: { title: string; body: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function snippet(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

function formatUpdatedAt(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function NotesPage({ notes, onCreate, onUpdate, onDelete }: NotesPageProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function openCreate() {
    setError(null);
    setDraft({ title: '', body: '' });
  }

  function openEdit(note: Note) {
    setError(null);
    setDraft({ id: note.id, title: note.title, body: note.body });
  }

  function close() {
    setDraft(null);
    setError(null);
  }

  async function handleSave() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      if (draft.id) {
        await onUpdate(draft.id, { title: draft.title, body: draft.body });
      } else {
        await onCreate({ title: draft.title, body: draft.body });
      }
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!draft?.id) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(draft.id);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="ca-agenda-header">
        <span className="display">Notes</span>
        <Button variant="primary" onClick={openCreate}>
          New note
        </Button>
      </div>

      {notes.length === 0 && <p className="body ca-event-empty">No notes yet.</p>}

      <div className="ca-notes-grid">
        {notes.map((note) => (
          <button type="button" key={note.id} className="ca-note-card" onClick={() => openEdit(note)}>
            <span className="body-strong ca-note-title">{note.title || 'Untitled note'}</span>
            {snippet(note.body) && <span className="caption ca-note-snippet">{snippet(note.body)}</span>}
            <span className="caption ca-note-date">{formatUpdatedAt(note.updatedAt)}</span>
          </button>
        ))}
      </div>

      {draft && (
        <Dialog title={draft.id ? 'Edit note' : 'New note'} onClose={close}>
          <NoteForm
            title={draft.title}
            onTitleChange={(v) => setDraft((d) => d && { ...d, title: v })}
            body={draft.body}
            onBodyChange={(v) => setDraft((d) => d && { ...d, body: v })}
            onSave={handleSave}
            onCancel={close}
            onDelete={draft.id ? handleDelete : undefined}
            error={error}
            busy={busy}
          />
        </Dialog>
      )}
    </div>
  );
}
