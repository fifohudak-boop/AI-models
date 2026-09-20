interface DayCellProps {
  dayNumber: number;
  isToday: boolean;
  hasEvents: boolean;
  onSelect: () => void;
}

export function DayCell({ dayNumber, isToday, hasEvents, onSelect }: DayCellProps) {
  return (
    <button
      type="button"
      className={`ca-day-circle-wrap`}
      onClick={onSelect}
    >
      <span className={`label ca-day-circle${isToday ? ' ca-day-circle-today' : ''}`}>{dayNumber}</span>
      <span className={`ca-day-dot${hasEvents ? ' ca-day-dot-visible' : ''}`} aria-hidden="true" />
    </button>
  );
}
