import { AlertCircle, Info, Inbox, Lock, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'error' | 'warn'; children: ReactNode }) {
  const Icon = tone === 'error' ? AlertCircle : tone === 'warn' ? TriangleAlert : Info;
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="state">
      {icon ?? <Inbox aria-hidden />}
      <p className="state__title">{title}</p>
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function ForbiddenState() {
  return (
    <div className="state">
      <Lock aria-hidden />
      <p className="state__title">No access</p>
      <p>Your role does not include this section.</p>
    </div>
  );
}

export function Skeleton({ width = '100%', height = 14 }: { width?: number | string; height?: number }) {
  return <span className="skeleton" style={{ width, height }} aria-hidden />;
}

export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="stack" style={{ padding: 24 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="row" style={{ gap: 24, flexWrap: 'nowrap' }}>
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} width={`${c === 0 ? 30 : 100 / cols}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}
