import { useEffect, useRef, useState } from 'react';
import type { Tab } from '../App';
import type { SystemDef } from '../systems';

// The top bar: one button per system (Post, Reel Finder, AI Studio, Editing, Metadata, Settings).
// Clicking a system rolls down its pages. The system holding the current page is highlighted, and
// Reel Finder shows a dot while a hunt is running.
export function SystemNav({
  systems,
  current,
  huntingName,
  onNavigate,
}: {
  systems: SystemDef[];
  current: Tab;
  huntingName: string | null;
  onNavigate: (tab: Tab) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const activeSystem = systems.find((s) => s.tabs.some((t) => t.id === current))?.id;

  function choose(system: SystemDef) {
    if (system.tabs.length === 1) {
      onNavigate(system.tabs[0].id);
      setOpen(null);
    } else {
      setOpen((o) => (o === system.id ? null : system.id));
    }
  }

  return (
    <nav className="systems" aria-label="Systems" ref={ref}>
      {systems.map((system) => {
        const isActive = activeSystem === system.id;
        const isOpen = open === system.id;
        const dot = system.id === 'reels' && huntingName;
        return (
          <div key={system.id} className="system">
            <button
              type="button"
              className={`tab system-tab${isActive ? ' active' : ''}${isOpen ? ' open' : ''}`}
              aria-haspopup={system.tabs.length > 1}
              aria-expanded={isOpen}
              onClick={() => choose(system)}
            >
              {system.label}
              {system.tabs.length > 1 && <span className="caret" aria-hidden="true">▾</span>}
              {dot && <span className="tab-dot" title={`Hunting for ${huntingName}`} />}
            </button>
            {isOpen && system.tabs.length > 1 && (
              <div className="system-menu" role="menu">
                {system.tabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitem"
                    className={`system-menu-item${current === t.id ? ' on' : ''}`}
                    onClick={() => {
                      onNavigate(t.id);
                      setOpen(null);
                    }}
                  >
                    {t.label}
                    {t.id === 'reels' && huntingName && <span className="tab-dot inline" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
