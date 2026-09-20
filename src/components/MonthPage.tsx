import { MonthHeader } from './MonthHeader';
import { WeekdayRow } from './WeekdayRow';
import { DayCell } from './DayCell';
import { formatMonthYear, getCurrentMonthDays, isSameDay } from '../lib/date-utils';

interface MonthPageProps {
  monthAnchor: Date;
  today: Date;
  datesWithEvents: Set<string>;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
  onSelectDay: (date: Date, iso: string) => void;
}

export function MonthPage({ monthAnchor, today, datesWithEvents, onPrevMonth, onNextMonth, onToday, onSelectDay }: MonthPageProps) {
  const days = getCurrentMonthDays(monthAnchor);

  return (
    <div>
      <MonthHeader label={formatMonthYear(monthAnchor)} onPrev={onPrevMonth} onNext={onNextMonth} onToday={onToday} />
      <WeekdayRow />
      <div className="ca-month-grid">
        {days.map((day, i) =>
          day ? (
            <DayCell
              key={day.iso}
              dayNumber={day.date.getDate()}
              isToday={isSameDay(day.date, today)}
              hasEvents={datesWithEvents.has(day.iso)}
              onSelect={() => onSelectDay(day.date, day.iso)}
            />
          ) : (
            <span key={`blank-${i}`} aria-hidden="true" />
          )
        )}
      </div>
    </div>
  );
}
