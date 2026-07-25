import { useState } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { useTopicSelection } from '../hooks/useTopicSelection';
import { ThemeToggle } from './ThemeToggle';

const NAV_LINKS = [
  { to: '/topics', label: 'Topics' },
  { to: '/feed', label: 'My evidence' },
  { to: '/archive', label: 'Archive' },
  { to: '/sources', label: 'Sources' },
  { to: '/subscribe', label: 'Subscribe' },
  { to: '/about', label: 'About' },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-2.5 text-sm font-medium ${
    isActive ? 'text-accent' : 'text-ink-muted hover:text-ink'
  }`;

export function Header() {
  const { selected } = useTopicSelection();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-[var(--color-paper)]/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link to="/" className="flex items-center gap-2 text-lg font-serif font-semibold text-ink">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-md text-sm font-bold"
            style={{ backgroundColor: 'var(--ed-accent)', color: 'var(--ed-accent-ink)' }}
          >
            ED
          </span>
          Evidence Digest
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => (
            <NavLink key={link.to} to={link.to} className={linkClass}>
              {link.label}
              {link.to === '/feed' && selected.length > 0 && (
                <span
                  className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-semibold"
                  style={{ backgroundColor: 'var(--ed-accent)', color: 'var(--ed-accent-ink)' }}
                  aria-label={`${selected.length} topics selected`}
                >
                  {selected.length}
                </span>
              )}
            </NavLink>
          ))}
          <ThemeToggle />
        </nav>

        <div className="flex items-center gap-2 md:hidden">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            className="flex h-11 w-11 items-center justify-center rounded-md border border-line-strong text-ink"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none">
              {open ? (
                <path
                  d="M5 5l14 14M19 5L5 19"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              ) : (
                <path
                  d="M4 7h16M4 12h16M4 17h16"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              )}
            </svg>
          </button>
        </div>
      </div>

      {open && (
        <nav id="mobile-nav" aria-label="Primary" className="border-t border-line px-4 pb-3 md:hidden">
          <ul className="flex flex-col">
            {NAV_LINKS.map((link) => (
              <li key={link.to}>
                <NavLink
                  to={link.to}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    `flex min-h-11 items-center justify-between rounded-md px-2 py-2.5 text-base font-medium ${
                      isActive ? 'text-accent' : 'text-ink'
                    }`
                  }
                >
                  {link.label}
                  {link.to === '/feed' && selected.length > 0 && (
                    <span
                      className="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-semibold"
                      style={{ backgroundColor: 'var(--ed-accent)', color: 'var(--ed-accent-ink)' }}
                    >
                      {selected.length}
                    </span>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </header>
  );
}
