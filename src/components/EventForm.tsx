import { CATEGORIES } from '../lib/categories';
import { Button } from './Button';

interface EventFormProps {
  title: string;
  onTitleChange: (value: string) => void;
  date: string;
  onDateChange: (value: string) => void;
  time: string;
  onTimeChange: (value: string) => void;
  location: string;
  onLocationChange: (value: string) => void;
  categoryId: string;
  onCategoryChange: (id: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}

export function EventForm({
  title,
  onTitleChange,
  date,
  onDateChange,
  time,
  onTimeChange,
  location,
  onLocationChange,
  categoryId,
  onCategoryChange,
  onSave,
  onCancel,
  onDelete,
}: EventFormProps) {
  return (
    <form
      className="ca-event-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <label className="ca-field">
        <span className="caption ca-field-label">Title</span>
        <input
          className="body ca-input"
          type="text"
          value={title}
          placeholder="Add a title"
          autoFocus
          required
          onChange={(e) => onTitleChange(e.target.value)}
        />
      </label>

      <div className="ca-field-row">
        <label className="ca-field" style={{ flex: 1 }}>
          <span className="caption ca-field-label">Date</span>
          <input className="label ca-input" type="date" value={date} onChange={(e) => onDateChange(e.target.value)} required />
        </label>
        <label className="ca-field" style={{ flex: 1 }}>
          <span className="caption ca-field-label">Time</span>
          <input
            className="label ca-input"
            type="text"
            value={time}
            placeholder="09:00–10:00"
            onChange={(e) => onTimeChange(e.target.value)}
          />
        </label>
      </div>

      <label className="ca-field">
        <span className="caption ca-field-label">Location (optional)</span>
        <input className="body ca-input" type="text" value={location} onChange={(e) => onLocationChange(e.target.value)} />
      </label>

      <div className="ca-field">
        <span className="caption ca-field-label">Category</span>
        <div className="ca-category-picker">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`ca-category-swatch ca-chip-${c.tone} ${categoryId === c.id ? 'ca-category-swatch-selected' : ''}`.trim()}
              onClick={() => onCategoryChange(c.id)}
              aria-label={c.label}
              aria-pressed={categoryId === c.id}
              title={c.label}
            />
          ))}
        </div>
      </div>

      <div className="ca-event-form-actions">
        {onDelete ? (
          <Button variant="danger" type="button" onClick={onDelete}>
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="ca-event-form-actions-right">
          <Button variant="secondary" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Save event
          </Button>
        </div>
      </div>
    </form>
  );
}
