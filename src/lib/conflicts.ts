import type { CalendarEvent } from '../types';
import { parseTimeRange, rangesOverlap } from './date-utils';

/** IDs of events that overlap another event on the same date (unparseable times never conflict). */
export function detectConflicts(events: CalendarEvent[]): Set<string> {
  const conflictIds = new Set<string>();
  const byDate = new Map<string, CalendarEvent[]>();

  for (const event of events) {
    const bucket = byDate.get(event.date);
    if (bucket) bucket.push(event);
    else byDate.set(event.date, [event]);
  }

  for (const dayEvents of byDate.values()) {
    for (let i = 0; i < dayEvents.length; i++) {
      const rangeA = parseTimeRange(dayEvents[i].time);
      if (!rangeA) continue;
      for (let j = i + 1; j < dayEvents.length; j++) {
        const rangeB = parseTimeRange(dayEvents[j].time);
        if (!rangeB) continue;
        if (rangesOverlap(rangeA, rangeB)) {
          conflictIds.add(dayEvents[i].id);
          conflictIds.add(dayEvents[j].id);
        }
      }
    }
  }

  return conflictIds;
}
