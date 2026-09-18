import { useCallback, useEffect, useMemo, useState } from 'react';
import { MonthHeader } from './components/MonthHeader';
import { WeekdayRow } from './components/WeekdayRow';
import { DayCell } from './components/DayCell';
import { EventListItem } from './components/EventListItem';
import { Dialog } from './components/Dialog';
import { EventForm } from './components/EventForm';
import { Button } from './components/Button';
import { addMonths, formatDayHeading, formatMonthYear, getMonthGrid, isSameDay, toISODate } from './lib/date-utils';
import { detectConflicts } from './lib/conflicts';
import { createEvent, deleteEvent, fetchCategories, fetchEvents, updateEvent } from './lib/api';
import type { CalendarEvent, Category } from './types';

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

export default function App() {
  const today = useMemo(() => new Date(), []);
  const [monthAnchor, setMonthAnchor] = useState(() => addMonths(today, 0));
  const [selectedIso, setSelectedIso] = useState(() => toISODate(today));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoadState({ status: 'loading' });
    Promise.all([fetchEvents(), fetchCategories()])
      .then(([loadedEvents, loadedCategories]) => {
        setEvents(loadedEvents);
        setCategories(loadedCategories);
        setLoadState({ status: 'ready' });
      })
      .catch((err: Error) => setLoadState({ status: 'error', message: err.message }));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const getCategory = useCallback(
    (id: string): Category => categories.find((c) => c.id === id) ?? { id, label: id, tone: 'accent' },
    [categories]
  );

  const conflictIds = useMemo(() => detectConflicts(events), [events]);
  const grid = useMemo(() => getMonthGrid(monthAnchor), [monthAnchor]);

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

  const selectedDayEvents = eventsByDate.get(selectedIso) ?? [];
  const selectedDate = useMemo(() => {
    const [y, m, d] = selectedIso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }, [selectedIso]);

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

  function openEditById(id: string) {
    const event = events.find((e) => e.id === id);
    if (event) openEdit(event);
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

  function handleSelectDay(iso: string, inCurrentMonth: boolean, date: Date) {
    setSelectedIso(iso);
    if (!inCurrentMonth) setMonthAnchor(addMonths(date, 0));
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
          <Button variant="primary" onClick={load}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="ca-app">
      <header className="ca-app-header">
        <div className="ca-app-title">
          <span className="display">Calendar</span>
        </div>
        <Button variant="primary" onClick={() => openCreate(selectedIso)}>
          New event
        </Button>
      </header>

      <MonthHeader
        label={formatMonthYear(monthAnchor)}
        onPrev={() => setMonthAnchor((m) => addMonths(m, -1))}
        onNext={() => setMonthAnchor((m) => addMonths(m, 1))}
        onToday={() => {
          setMonthAnchor(addMonths(today, 0));
          setSelectedIso(toISODate(today));
        }}
      />

      <div className="ca-layout">
        <div>
          <WeekdayRow />
          <div className="ca-month-grid">
            {grid.map(({ date, iso, inCurrentMonth }) => {
              const dayEvents = eventsByDate.get(iso) ?? [];
              return (
                <DayCell
                  key={iso}
                  dayNumber={date.getDate()}
                  isToday={isSameDay(date, today)}
                  isOtherMonth={!inCurrentMonth}
                  isSelected={iso === selectedIso}
                  onSelect={() => handleSelectDay(iso, inCurrentMonth, date)}
                  onEventClick={openEditById}
                  events={dayEvents.map((e) => ({
                    id: e.id,
                    label: e.title,
                    tone: conflictIds.has(e.id) ? 'danger' : getCategory(e.categoryId).tone,
                  }))}
                />
              );
            })}
          </div>
        </div>

        <div className="ca-panel">
          <div className="ca-agenda-header">
            <span className="heading">Agenda</span>
            <Button variant="secondary" onClick={() => openCreate(selectedIso)}>
              Add
            </Button>
          </div>
          <p className="caption ca-agenda-date">{formatDayHeading(selectedDate)}</p>
          <div className="ca-event-list">
            {selectedDayEvents.length === 0 && <p className="body ca-event-empty">No events scheduled.</p>}
            {selectedDayEvents.map((e) => (
              <EventListItem
                key={e.id}
                time={e.time}
                title={e.title}
                location={e.location}
                tone={conflictIds.has(e.id) ? 'danger' : getCategory(e.categoryId).tone}
                onClick={() => openEdit(e)}
              />
            ))}
          </div>
        </div>
      </div>

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
