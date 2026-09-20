import { useCallback, useEffect, useMemo, useState } from 'react';
import { TopNav } from './components/TopNav';
import { AuthScreen } from './components/AuthScreen';
import { MonthPage } from './components/MonthPage';
import { DayAgendaPage } from './components/DayAgendaPage';
import { NotesPage } from './components/NotesPage';
import { Dialog } from './components/Dialog';
import { EventForm } from './components/EventForm';
import { Button } from './components/Button';
import { addDays, addMonths, isSameDay, toISODate } from './lib/date-utils';
import { detectConflicts } from './lib/conflicts';
import {
  createEvent,
  createNote,
  deleteEvent,
  deleteNote,
  fetchCategories,
  fetchEvents,
  fetchMe,
  fetchNotes,
  logout,
  updateEvent,
  updateNote,
} from './lib/api';
import type { CalendarEvent, Category, Note, User } from './types';

interface Draft {
  id?: string;
  title: string;
  date: string;
  time: string;
  location: string;
  categoryId: string;
}

function emptyDraft(dateIso: string, defaultCategoryId: string): Draft {
  return { title: '', date: dateIso, time: '', location: '', categoryId: defaultCategoryId };
}

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };
type CalendarView = { mode: 'month' } | { mode: 'day'; date: Date };

export default function App() {
  const today = useMemo(() => new Date(), []);

  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser] = useState<User | null>(null);

  const [page, setPage] = useState<'calendar' | 'notes'>('calendar');
  const [monthAnchor, setMonthAnchor] = useState(() => addMonths(today, 0));
  const [calendarView, setCalendarView] = useState<CalendarView>({ mode: 'day', date: today });

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchMe()
      .then((u) => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true));
  }, []);

  const loadData = useCallback(() => {
    setLoadState({ status: 'loading' });
    Promise.all([fetchEvents(), fetchCategories(), fetchNotes()])
      .then(([loadedEvents, loadedCategories, loadedNotes]) => {
        setEvents(loadedEvents);
        setCategories(loadedCategories);
        setNotes(loadedNotes);
        setLoadState({ status: 'ready' });
      })
      .catch((err: Error) => setLoadState({ status: 'error', message: err.message }));
  }, []);

  useEffect(() => {
    if (user) loadData();
  }, [user, loadData]);

  const getCategory = useCallback(
    (id: string): Category => categories.find((c) => c.id === id) ?? { id, label: id, tone: 'accent' },
    [categories]
  );

  const conflictIds = useMemo(() => detectConflicts(events), [events]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const bucket = map.get(event.date);
      if (bucket) bucket.push(event);
      else map.set(event.date, [event]);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.time.localeCompare(b.time));
    return map;
  }, [events]);

  const datesWithEvents = useMemo(() => new Set(eventsByDate.keys()), [eventsByDate]);

  function openCreate(dateIso: string) {
    setFormError(null);
    setDraft(emptyDraft(dateIso, categories[0]?.id ?? ''));
  }

  function openEdit(event: CalendarEvent) {
    setFormError(null);
    setDraft({
      id: event.id,
      title: event.title,
      date: event.date,
      time: event.time,
      location: event.location ?? '',
      categoryId: event.categoryId,
    });
  }

  function closeDialog() {
    setDraft(null);
    setFormError(null);
  }

  async function handleSave() {
    if (!draft || !draft.title.trim()) return;
    const input = {
      title: draft.title.trim(),
      date: draft.date,
      time: draft.time.trim(),
      location: draft.location.trim() || undefined,
      categoryId: draft.categoryId,
    };

    setSaving(true);
    setFormError(null);
    try {
      if (draft.id) {
        const updated = await updateEvent(draft.id, input);
        setEvents((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
      } else {
        const created = await createEvent(input);
        setEvents((prev) => [...prev, created]);
      }
      closeDialog();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!draft?.id) return;
    setSaving(true);
    setFormError(null);
    try {
      await deleteEvent(draft.id);
      setEvents((prev) => prev.filter((e) => e.id !== draft.id));
      closeDialog();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  async function handleLogout() {
    try {
      await logout();
    } catch {
      // Even if the request fails, drop the client-side session so the auth screen shows.
    }
    setUser(null);
    setEvents([]);
    setCategories([]);
    setNotes([]);
    setPage('calendar');
    setCalendarView({ mode: 'day', date: today });
  }

  if (!authChecked) {
    return (
      <div className="ca-app">
        <p className="body ca-load-status">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen onAuthenticated={setUser} />;
  }

  if (loadState.status === 'loading') {
    return (
      <div className="ca-app">
        <p className="body ca-load-status">Loading your calendar…</p>
      </div>
    );
  }

  if (loadState.status === 'error') {
    return (
      <div className="ca-app">
        <div className="ca-panel ca-load-status">
          <p className="body-strong">Couldn't reach the calendar server.</p>
          <p className="caption ca-agenda-date">{loadState.message}</p>
          <Button variant="primary" onClick={loadData}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="ca-app">
      <TopNav page={page} onPageChange={setPage} username={user.username} onLogout={handleLogout} />

      {page === 'calendar' &&
        (calendarView.mode === 'month' ? (
          <MonthPage
            monthAnchor={monthAnchor}
            today={today}
            datesWithEvents={datesWithEvents}
            onPrevMonth={() => setMonthAnchor((m) => addMonths(m, -1))}
            onNextMonth={() => setMonthAnchor((m) => addMonths(m, 1))}
            onToday={() => {
              setMonthAnchor(addMonths(today, 0));
              setCalendarView({ mode: 'day', date: today });
            }}
            onSelectDay={(date) => setCalendarView({ mode: 'day', date })}
          />
        ) : (
          <DayAgendaPage
            date={calendarView.date}
            isToday={isSameDay(calendarView.date, today)}
            events={(eventsByDate.get(toISODate(calendarView.date)) ?? []).map((e) => ({
              ...e,
              tone: conflictIds.has(e.id) ? 'danger' : getCategory(e.categoryId).tone,
            }))}
            onBackToMonth={() => setCalendarView({ mode: 'month' })}
            onPrevDay={() => setCalendarView({ mode: 'day', date: addDays(calendarView.date, -1) })}
            onNextDay={() => setCalendarView({ mode: 'day', date: addDays(calendarView.date, 1) })}
            onAddEvent={() => openCreate(toISODate(calendarView.date))}
            onEditEvent={openEdit}
          />
        ))}

      {page === 'notes' && (
        <NotesPage
          notes={notes}
          onCreate={async (input) => {
            const created = await createNote(input);
            setNotes((prev) => [created, ...prev]);
          }}
          onUpdate={async (id, input) => {
            const updated = await updateNote(id, input);
            setNotes((prev) => prev.map((n) => (n.id === id ? updated : n)));
          }}
          onDelete={async (id) => {
            await deleteNote(id);
            setNotes((prev) => prev.filter((n) => n.id !== id));
          }}
        />
      )}

      {draft && (
        <Dialog title={draft.id ? 'Edit event' : 'New event'} onClose={closeDialog}>
          <EventForm
            title={draft.title}
            onTitleChange={(v) => setDraft((d) => d && { ...d, title: v })}
            date={draft.date}
            onDateChange={(v) => setDraft((d) => d && { ...d, date: v })}
            time={draft.time}
            onTimeChange={(v) => setDraft((d) => d && { ...d, time: v })}
            location={draft.location}
            onLocationChange={(v) => setDraft((d) => d && { ...d, location: v })}
            categoryId={draft.categoryId}
            onCategoryChange={(id) => setDraft((d) => d && { ...d, categoryId: id })}
            categories={categories}
            onSave={handleSave}
            onCancel={closeDialog}
            onDelete={draft.id ? handleDelete : undefined}
            error={formError}
            busy={saving}
          />
        </Dialog>
      )}
    </div>
  );
}
