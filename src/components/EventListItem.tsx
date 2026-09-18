import type { Tone } from '../types';

interface EventListItemProps {
  time: string;
  title: string;
  location?: string;
  tone?: Tone;
  onClick?: () => void;
}

export function EventListItem({ time, title, location, tone = 'accent', onClick }: EventListItemProps) {
  return (
    <button type="button" className="ca-event-item" onClick={onClick}>
      <span className={`ca-event-bar ca-event-bar-${tone}`} />
      <div className="ca-event-body">
        <span className="label ca-event-time">{time}</span>
        <span className="body-strong ca-event-title">{title}</span>
        {location && <span className="caption ca-event-location">{location}</span>}
      </div>
    </button>
  );
}
