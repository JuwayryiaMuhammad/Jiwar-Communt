'use client';

import { Field, Input, useCommonT } from '@jiwar/ui';

/** `<input type="date">` gives local dates; the API wants ISO instants. */
export function startOfDay(date: string): string | undefined {
  return date ? new Date(`${date}T00:00:00`).toISOString() : undefined;
}

export function endOfDay(date: string): string | undefined {
  return date ? new Date(`${date}T23:59:59.999`).toISOString() : undefined;
}

export function DateRange({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
}) {
  const c = useCommonT();
  return (
    <>
      <Field label={c('from')}>
        {(p) => <Input {...p} type="date" value={from} max={to || undefined} onChange={(e) => onChange({ from: e.target.value, to })} />}
      </Field>
      <Field label={c('to')}>
        {(p) => <Input {...p} type="date" value={to} min={from || undefined} onChange={(e) => onChange({ from, to: e.target.value })} />}
      </Field>
    </>
  );
}
