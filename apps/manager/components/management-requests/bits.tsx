'use client';

import { formatDateTime, relativeTime } from '@jiwar/api';
import { Badge, Select } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import type { SelectHTMLAttributes } from 'react';
import { fetchers, keys, type AppointmentMode, type ManagementRequestType } from '@/lib/queries';

export function personName(p: { fullName?: string | null; erased?: boolean } | null | undefined): string {
  if (!p) return '—';
  return p.erased ? 'Erased account' : (p.fullName ?? '—');
}

export const TYPE_TEXT: Record<ManagementRequestType, string> = {
  question: 'Question',
  general: 'General',
  appointment: 'Appointment',
};

export const MODE_TEXT: Record<AppointmentMode, string> = { in_person: 'In person', phone: 'By phone' };

const slotDay = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
const slotTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** "Mon, 13 Oct · 09:00–09:30", in the browser's time zone. */
export function slotText(startsAt: string, endsAt: string): string {
  const [start, end] = [new Date(startsAt), new Date(endsAt)];
  return `${slotDay.format(start)} · ${slotTime.format(start)}–${slotTime.format(end)}`;
}

/** Where the response clock stands: overdue, escalated, due, or answered in time. */
export function ResponseBadges({
  request,
}: {
  request: { overdue: boolean; escalatedAt: string | null; firstResponseAt: string | null; responseDueAt: string; status: string };
}) {
  const waiting = !request.firstResponseAt && (request.status === 'open' || request.status === 'in_progress');
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      {request.overdue ? <Badge tone="error">Overdue</Badge> : null}
      {request.escalatedAt ? (
        <span title={`Escalated ${formatDateTime(request.escalatedAt)}`}>
          <Badge tone="terracotta">Escalated</Badge>
        </span>
      ) : null}
      {waiting && !request.overdue ? (
        <span className="t-secondary" title={formatDateTime(request.responseDueAt)} style={{ whiteSpace: 'nowrap' }}>
          Due {relativeTime(request.responseDueAt)}
        </span>
      ) : null}
      {!waiting && !request.overdue && !request.escalatedAt ? <span className="t-secondary">—</span> : null}
    </span>
  );
}

/** The accounts that handle requests, by name. */
export function HandlerPicker(props: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & { placeholder?: string; exclude?: string }) {
  const { placeholder = 'Select a handler…', exclude, ...rest } = props;
  const handlers = useQuery({ queryKey: keys.requestAssignees, queryFn: fetchers.requestAssignees });
  return (
    <Select {...rest}>
      <option value="">{handlers.isPending ? 'Loading…' : placeholder}</option>
      {(handlers.data?.data ?? [])
        .filter((h) => h.id !== exclude)
        .map((h) => (
          <option key={h.id} value={h.id}>
            {h.fullName ?? 'Unnamed account'}
          </option>
        ))}
    </Select>
  );
}

/** The free slots of the next two weeks, with the places left in each. */
export function SlotPicker(props: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & { enabled?: boolean }) {
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
      <option value="">{slots.isPending && enabled ? 'Loading slots…' : list.length ? 'Select a slot…' : 'No free slot in the next 14 days'}</option>
      {list.map((s) => (
        <option key={s.startsAt} value={s.startsAt}>
          {slotText(s.startsAt, s.endsAt)}
          {s.remaining > 1 ? ` · ${s.remaining} places` : ''}
        </option>
      ))}
    </Select>
  );
}
