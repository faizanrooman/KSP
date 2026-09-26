import { useState, type ReactNode } from 'react';
import { NavLink, Link, useNavigate } from 'react-router-dom';
import { LogOut, Menu, ShieldCheck, UserCircle2, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { MODULES, NAV_SECTIONS, type NavItem } from '@/lib/modules';
import { clsx } from '@/components/ui';
import { NotificationBell } from '@/modules/alerts/NotificationBell';

function visibleNav(canAny: (...p: never[]) => boolean): Map<string, NavItem[]> {
  const items = MODULES.flatMap((m) => m.nav ?? []).filter((n) => !n.anyOf || canAny(...(n.anyOf as never[])));
  const bySection = new Map<string, NavItem[]>();
  for (const s of NAV_SECTIONS) {
    const list = items.filter((i) => i.section === s).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    if (list.length) bySection.set(s, list);
  }
  return bySection;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, logout, canAny } = useAuth();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const nav = visibleNav(canAny as never);

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col">
      <Link to="/" className="flex items-center gap-2 px-4 py-4 text-white">
        <ShieldCheck className="h-7 w-7 text-brand-300" aria-hidden />
        <span className="leading-tight">
          <span className="block text-sm font-semibold">KSP Evidence</span>
          <span className="block text-[11px] text-brand-200">Video Management System</span>
        </span>
      </Link>
      <div className="flex-1 space-y-4 overflow-y-auto px-2 pb-4">
        {[...nav].map(([section, items]) => (
          <div key={section}>
            <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-brand-300/80">{section}</p>
            <ul className="space-y-0.5">
              {items.map((i) => (
                <li key={i.to}>
                  <NavLink
                    to={i.to}
                    end={i.to === '/'}
                    onClick={() => setOpen(false)}
                    className={({ isActive }) => clsx('flex items-center gap-2 rounded-md px-2 py-1.5 text-sm', isActive ? 'bg-brand-800 text-white' : 'text-brand-100 hover:bg-brand-900 hover:text-white')}
                  >
                    <i.icon className="h-4 w-4 shrink-0" aria-hidden />
                    {i.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-brand-900 px-4 py-3 text-xs text-brand-200">
        Authorised use only. All activity is recorded in the audit trail.
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-2">
        Skip to content
      </a>
      <aside className="hidden w-60 shrink-0 bg-brand-950 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="w-64 bg-brand-950">{sidebar}</div>
          <button type="button" className="flex-1 bg-ink-950/50" aria-label="Close menu" onClick={() => setOpen(false)} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-ink-200 bg-white px-4">
          <button type="button" className="rounded p-1.5 hover:bg-ink-100 lg:hidden" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <div className="flex-1 truncate text-sm text-ink-600">{me?.user.homeOrgUnit.name}</div>
          <NotificationBell />
          <Link to="/profile" className="flex items-center gap-2 rounded px-2 py-1 text-sm text-ink-700 hover:bg-ink-100">
            <UserCircle2 className="h-5 w-5" aria-hidden />
            <span className="sr-only sm:not-sr-only">
              {me?.user.fullName}
              {me?.user.badgeNumber && <span className="ml-1 text-ink-500">({me.user.badgeNumber})</span>}
            </span>
          </Link>
          <button
            type="button"
            className="flex items-center gap-1 rounded px-2 py-1 text-sm text-ink-700 hover:bg-ink-100"
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
          >
            <LogOut className="h-4 w-4" aria-hidden />
            <span className="sr-only sm:not-sr-only">Sign out</span>
          </button>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1600px] flex-1 p-4 outline-none lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
