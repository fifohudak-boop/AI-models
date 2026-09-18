import type { Tone } from '../types';
import { EventChip } from './EventChip';

interface DayCellEvent {
  id: string;
  label: string;
  tone: Tone;
}

interface DayCellProps {
  dayNumber: number;
  events: DayCellEvent[];
  isToday: boolean;
  isOtherMonth: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onEventClick: (id: string) => void;
}

const MAX_VISIBLE = 3;

export function DayCell({ dayNumber, events, isToday, isOtherMonth, isSelected, onSelect, onEventClick }: DayCellProps) {
  const visible = events.slice(0, MAX_VISIBLE);
  const overflow = events.length - visible.length;

  return (
    <div
      className={`ca-day-cell ${isSelected ? 'ca-day-cell-selected' : ''}`.trim()}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect();
      }}
    >
      <span className={`label ca-day-number ${isToday ? 'ca-day-number-today' : isOtherMonth ? 'ca-day-number-other' : ''}`.trim()}>
        {dayNumber}
      </span>
      <div className="ca-day-events">
        {visible.map((e) => (
          <EventChip key={e.id} label={e.label} tone={e.tone} compact onClick={() => onEventClick(e.id)} />
        ))}
        {overflow > 0 && <span className="caption ca-day-more">+{overflow} more</span>}
      </div>
    </div>
  );
}
