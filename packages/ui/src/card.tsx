import Link from 'next/link';
import type { ReactNode } from 'react';

export function Card({
  tone,
  flush,
  className,
  children,
}: {
  tone?: 'green' | 'beige' | 'dark';
  flush?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const cls = ['card', tone && `card--${tone}`, flush && 'card--flush', className].filter(Boolean).join(' ');
  return <section className={cls}>{children}</section>;
}

export function CardHeader({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="card__header">
      <div className="stack stack--sm" style={{ gap: 2 }}>
        <h2>{title}</h2>
        {children}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </header>
  );
}

export function CardBody({ children }: { children: ReactNode }) {
  return <div className="card__body">{children}</div>;
}

export function CardFooter({ children }: { children: ReactNode }) {
  return <footer className="card__footer">{children}</footer>;
}

export function Stat({
  label,
  value,
  hint,
  icon,
  href,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  href?: string;
  tone?: 'green' | 'beige' | 'dark';
}) {
  const inner = (
    <>
      <span className="stat__label">
        {icon}
        {label}
      </span>
      <span className="stat__value">{value}</span>
      {hint ? <span className="stat__hint">{hint}</span> : null}
    </>
  );
  return (
    <Card tone={tone}>
      {href ? (
        <Link href={href} className="stat">
          {inner}
        </Link>
      ) : (
        <div className="stat">{inner}</div>
      )}
    </Card>
  );
}
