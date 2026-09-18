import type { Tone } from '../types';

interface EventChipProps {
  label: string;
  tone?: Tone;
  compact?: boolean;
  onClick?: () => void;
}

export function EventChip({ label, tone = 'accent', compact = false, onClick }: EventChipProps) {
  return (
    <button
      type="button"
      className={`${compact ? 'label' : 'body-strong'} ca-chip ca-chip-${tone} ${compact ? 'ca-chip-compact' : ''}`.trim()}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      title={label}
    >
      {label}
    </button>
  );
}
