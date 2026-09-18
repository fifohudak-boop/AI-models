interface MonthHeaderProps {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}

export function MonthHeader({ label, onPrev, onNext, onToday }: MonthHeaderProps) {
  return (
    <div className="ca-month-header">
      <span className="display">{label}</span>
      <div className="ca-month-header-nav">
        <button className="ca-button ca-button-secondary body-strong" onClick={onToday}>
          Today
        </button>
        <button className="ca-icon-button" onClick={onPrev} aria-label="Previous month">
          ‹
        </button>
        <button className="ca-icon-button" onClick={onNext} aria-label="Next month">
          ›
        </button>
      </div>
    </div>
  );
}
