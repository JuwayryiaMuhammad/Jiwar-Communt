'use client';

import Link from 'next/link';
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'dark' | 'danger' | 'text' | 'ghost-dark';

function classes(variant: Variant, size?: 'sm', iconOnly?: boolean, extra?: string) {
  return ['btn', `btn--${variant}`, size === 'sm' && 'btn--sm', iconOnly && 'btn--icon', extra]
    .filter(Boolean)
    .join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm';
  icon?: ReactNode;
  loading?: boolean;
  iconOnly?: boolean;
}

export function Button({
  variant = 'secondary',
  size,
  icon,
  loading,
  iconOnly,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={classes(variant, size, iconOnly, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="btn__spinner" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function ButtonLink({
  variant = 'secondary',
  size,
  icon,
  className,
  children,
  ...rest
}: ComponentProps<typeof Link> & { variant?: Variant; size?: 'sm'; icon?: ReactNode }) {
  return (
    <Link className={classes(variant, size, false, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
