import { weekdayLabels } from '../lib/date-utils';

export function WeekdayRow() {
  return (
    <div className="ca-weekday-row">
      {weekdayLabels().map((label) => (
        <span key={label} className="subheading ca-weekday">
          {label}
        </span>
      ))}
    </div>
  );
}
