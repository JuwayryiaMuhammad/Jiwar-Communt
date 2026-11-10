'use client';

import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Select } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useCallback, type SelectHTMLAttributes } from 'react';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/services-mgmt-requests';
import en from '@/messages/en/services-mgmt-requests';

type Person = { fullName?: string | null; erased?: boolean } | null | undefined;

/** English only: the pages outside the requests still read it (use `usePersonName`). */
export function personName(p: Person): string {
  if (!p) return '—';
  return p.erased ? 'Erased account' : (p.fullName ?? '—');
}

/** A person's name, or "Erased account" in the page's language. */
export function usePersonName() {
  const t = useT(en, ar);
  return useCallback((p: Person) => (!p ? '—' : p.erased ? t('erased') : (p.fullName ?? '—')), [t]);
}

const slotDay = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
const slotTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** English only: the pages outside the requests still read it (use `useSlotText`). */
export function slotText(startsAt: string, endsAt: string): string {
  const [start, end] = [new Date(startsAt), new Date(endsAt)];
  return `${slotDay.format(start)} · ${slotTime.format(start)}–${slotTime.format(end)}`;
}

/** "Mon, 13 Oct · 09:00–09:30", in the page's language and the browser's time zone. */
export function useSlotText() {
  const fmt = useFormat();
  return useCallback(
    (startsAt: string, endsAt: string) =>
      `${fmt.custom(startsAt, { weekday: 'short', day: '2-digit', month: 'short' })} · ${fmt.time(startsAt)}–${fmt.time(endsAt)}`,
    [fmt],
  );
}

/** Where the response clock stands: overdue, escalated, due, or answered in time. */
export function ResponseBadges({
  request,
}: {
  request: { overdue: boolean; escalatedAt: string | null; firstResponseAt: string | null; responseDueAt: string; status: string };
}) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const waiting = !request.firstResponseAt && (request.status === 'open' || request.status === 'in_progress');
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      {request.overdue ? <Badge tone="error">{t('overdue')}</Badge> : null}
      {request.escalatedAt ? (
        <span title={t('escalatedOn', { when: fmt.dateTime(request.escalatedAt) })}>
          <Badge tone="terracotta">{t('escalated')}</Badge>
        </span>
      ) : null}
      {waiting && !request.overdue ? (
        <span className="t-secondary" title={fmt.dateTime(request.responseDueAt)} style={{ whiteSpace: 'nowrap' }}>
          {t('dueIn', { when: fmt.relative(request.responseDueAt) })}
        </span>
      ) : null}
      {!waiting && !request.overdue && !request.escalatedAt ? <span className="t-secondary">—</span> : null}
    </span>
  );
}

/** The accounts that handle requests, by name. */
export function HandlerPicker(props: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & { placeholder?: string; exclude?: string }) {
  const t = useT(en, ar);
  const { placeholder = t('handlerPlaceholder'), exclude, ...rest } = props;
  const handlers = useQuery({ queryKey: keys.requestAssignees, queryFn: fetchers.requestAssignees });
  return (
    <Select {...rest}>
      <option value="">{handlers.isPending ? t('loading') : placeholder}</option>
      {(handlers.data?.data ?? [])
        .filter((h) => h.id !== exclude)
        .map((h) => (
          <option key={h.id} value={h.id}>
            {h.fullName ?? t('unnamed')}
          </option>
        ))}
    </Select>
  );
}

/** The free slots of the next two weeks, with the places left in each. */
export function SlotPicker(props: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & { enabled?: boolean }) {
  const t = useT(en, ar);
  const slotLine = useSlotText();
  const { enabled = true, ...rest } = props;
  const slots = useQuery({
    queryKey: keys.appointmentSlots('today', 14),
    queryFn: () => fetchers.appointmentSlots(undefined, 14),
    enabled,
    staleTime: 0,
  });
  const list = slots.data?.data ?? [];
  return (
    <Select {...rest}>
      <option value="">{slots.isPending && enabled ? t('slots.loading') : list.length ? t('slots.select') : t('slots.none')}</option>
      {list.map((s) => (
        <option key={s.startsAt} value={s.startsAt}>
          {s.remaining > 1 ? `${slotLine(s.startsAt, s.endsAt)} · ${t('slots.places', { n: s.remaining })}` : slotLine(s.startsAt, s.endsAt)}
        </option>
      ))}
    </Select>
  );
}
