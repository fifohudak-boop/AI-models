interface TopNavProps {
  page: 'calendar' | 'notes';
  onPageChange: (page: 'calendar' | 'notes') => void;
  username: string;
  onLogout: () => void;
}

export function TopNav({ page, onPageChange, username, onLogout }: TopNavProps) {
  return (
    <header className="ca-top-nav">
      <nav className="ca-top-nav-tabs">
        <button
          type="button"
          className={`body-strong ca-top-nav-tab ${page === 'calendar' ? 'ca-top-nav-tab-active' : ''}`}
          onClick={() => onPageChange('calendar')}
        >
          Calendar
        </button>
        <button
          type="button"
          className={`body-strong ca-top-nav-tab ${page === 'notes' ? 'ca-top-nav-tab-active' : ''}`}
          onClick={() => onPageChange('notes')}
        >
          Notes
        </button>
      </nav>
      <div className="ca-top-nav-user">
        <span className="caption ca-top-nav-username">{username}</span>
        <button type="button" className="caption ca-top-nav-logout" onClick={onLogout}>
          Log out
        </button>
      </div>
    </header>
  );
}
