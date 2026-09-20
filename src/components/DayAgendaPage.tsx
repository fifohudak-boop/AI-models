import { EventListItem } from './EventListItem';
import { Button } from './Button';
import type { CalendarEvent, Tone } from '../types';
import { formatDayHeading } from '../lib/date-utils';

interface AgendaEvent extends CalendarEvent {
  tone: Tone;
}

interface DayAgendaPageProps {
  date: Date;
  events: AgendaEvent[];
  isToday: boolean;
  onBackToMonth: () => void;
  onPrevDay: () => void;
  onNextDay: () => void;
  onAddEvent: () => void;
  onEditEvent: (event: CalendarEvent) => void;
}

export function DayAgendaPage({ date, events, isToday, onBackToMonth, onPrevDay, onNextDay, onAddEvent, onEditEvent }: DayAgendaPageProps) {
  return (
    <div className="ca-agenda-page">
      <div className="ca-agenda-page-header">
        <button type="button" className="ca-icon-button" onClick={onBackToMonth} aria-label="Back to month view">
          ⤢
        </button>
        <div className="ca-agenda-page-title">
          <span className="heading">{formatDayHeading(date)}</span>
          {isToday && <span className="caption ca-agenda-today-badge">Today</span>}
        </div>
        <div className="ca-agenda-page-nav">
          <button type="button" className="ca-icon-button" onClick={onPrevDay} aria-label="Previous day">
            ‹
          </button>
          <button type="button" className="ca-icon-button" onClick={onNextDay} aria-label="Next day">
            ›
          </button>
        </div>
      </div>

      <div className="ca-panel ca-agenda-page-body">
        <div className="ca-agenda-header">
          <span className="subheading">Schedule</span>
          <Button variant="primary" onClick={onAddEvent}>
            New event
          </Button>
        </div>
        <div className="ca-event-list">
          {events.length === 0 && <p className="body ca-event-empty">No events scheduled.</p>}
          {events.map((e) => (
            <EventListItem key={e.id} time={e.time} title={e.title} location={e.location} tone={e.tone} onClick={() => onEditEvent(e)} />
          ))}
        </div>
      </div>
    </div>
  );
}
