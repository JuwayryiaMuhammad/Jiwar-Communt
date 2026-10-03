'use client';

import { LogOut, Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './button';

export interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  count?: number;
  /** Exact match only (for "/"). */
  exact?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

/**
 * The dashboard frame: the sidebar is the design's dark band (it frames
 * the product UI), the content sits on the white canvas.
 */
export function AppShell({
  product,
  context,
  nav,
  user,
  onSignOut,
  signingOut,
  topbarEnd,
  children,
}: {
  product: string;
  context: string;
  nav: NavGroup[];
  user: { name: string; meta: string } | null;
  onSignOut: () => void;
  signingOut?: boolean;
  topbarEnd?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + '/');

  const current = nav.flatMap((g) => g.items).find(isActive);

  return (
    <div className="shell" data-nav-open={open}>
      <aside className="sidebar" aria-label="Main navigation">
        <Link href="/" className="sidebar__brand">
          <span className="sidebar__mark" aria-hidden>
            J
          </span>
          <span>
            <span className="sidebar__name" style={{ display: 'block' }}>
              {product}
            </span>
            <span className="sidebar__context">{context}</span>
          </span>
        </Link>
        <nav className="stack" style={{ gap: 20 }}>
          {nav.map((group, i) => (
            <div className="sidebar__group" key={group.label ?? i}>
              {group.label ? <span className="sidebar__label">{group.label}</span> : null}
              {group.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="sidebar__link"
                  aria-current={isActive(item) ? 'page' : undefined}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {item.count ? <span className="sidebar__count">{item.count > 99 ? '99+' : item.count}</span> : null}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar__footer">
          {user ? (
            <div className="sidebar__user">
              <span className="avatar" aria-hidden>
                {initials(user.name) || '?'}
              </span>
              <span className="sidebar__user-text">
                <span className="sidebar__user-name" style={{ display: 'block' }}>
                  {user.name}
                </span>
                <span className="sidebar__user-meta" style={{ display: 'block' }}>
                  {user.meta}
                </span>
              </span>
            </div>
          ) : null}
          <Button variant="ghost-dark" icon={<LogOut aria-hidden />} onClick={onSignOut} loading={signingOut}>
            Sign out
          </Button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} aria-hidden />
      <div className="main">
        <header className="topbar">
          <Button
            className="topbar__menu"
            variant="secondary"
            size="sm"
            iconOnly
            aria-label="Open navigation"
            icon={<Menu aria-hidden />}
            onClick={() => setOpen(true)}
          />
          <div className="topbar__crumbs">
            <span>{product}</span>
            {current ? (
              <>
                <span aria-hidden>/</span>
                <span aria-current="page">{current.label}</span>
              </>
            ) : null}
          </div>
          <div className="topbar__end">{topbarEnd}</div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div className="page-header__text">
        {back}
        <h1 className="t-display-md">{title}</h1>
        {description ? <p className="t-secondary">{description}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </div>
  );
}
