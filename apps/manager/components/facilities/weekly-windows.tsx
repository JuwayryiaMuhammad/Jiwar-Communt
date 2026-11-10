'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Button, Card, CardBody, CardHeader, Select, useCommonT, useToast } from '@jiwar/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { clock, halfHours, sameWindows, sortWindows, type Window } from '@/components/management-requests/logic';
import { api } from '@/lib/api';
import { keys, type Facility } from '@/lib/queries';
import ar from '@/messages/ar/places-facilities';
import en from '@/messages/en/places-facilities';
import { windowIssues } from './logic';

/** Half hours, plus the saved value when it is off the grid. */
const options = (end: boolean, saved: number) => [...new Set([...halfHours(end), saved])].sort((a, b) => a - b);
/** Days in the order the week is worked here: Saturday first. */
const ORDER = [6, 0, 1, 2, 3, 4, 5];

/**
 * A facility's weekly windows (ADR 0044) in the compound's local time: its
 * opening hours, or its peak times, which lie inside them. The whole week
 * is saved at once. Bookings already made keep their time whatever the
 * windows become.
 */
export function WeeklyWindows({ facility, kind }: { facility: Facility; kind: 'hours' | 'peaks' }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const toast = useToast();
  const saved = kind === 'hours' ? facility.hours : facility.peakWindows;
  const [windows, setWindows] = useState<Window[]>(saved);

  const save = useAction(
    () =>
      unwrap(
        kind === 'hours'
          ? api.PUT('/api/v1/staff/facilities/{id}/hours', { params: { path: { id: facility.id } }, body: { windows: sortWindows(windows) } })
          : api.PUT('/api/v1/staff/facilities/{id}/peak-windows', {
              params: { path: { id: facility.id } },
              body: { windows: sortWindows(windows) },
            }),
      ),
    {
      invalidate: [keys.facilitiesAll],
      onDone: (next) => {
        setWindows(kind === 'hours' ? next.hours : next.peakWindows);
        toast.show(t(`${kind}.saved`));
      },
    },
  );

  const problems = windowIssues(windows);
  const invalid = Object.keys(problems).length > 0;
  const dirty = !sameWindows(windows, saved);
  const update = (index: number, patch: Partial<Window>) => setWindows(windows.map((w, i) => (i === index ? { ...w, ...patch } : w)));
  const add = (weekday: number) => {
    const last = Math.max(0, ...windows.filter((w) => w.weekday === weekday).map((w) => w.endMinute));
    const start = last ? Math.min(last, 1380) : kind === 'hours' ? 360 : 1080;
    setWindows([...windows, { weekday, startMinute: start, endMinute: Math.min(start + (last ? 60 : kind === 'hours' ? 960 : 180), 1440) }]);
  };
  const error = (index: number) => {
    const problem = problems[index];
    return (
      (problem ? t(`window.${problem}`) : undefined) ??
      fieldError(save.error, `windows.${index}.startMinute`) ??
      fieldError(save.error, `windows.${index}.endMinute`)
    );
  };

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !invalid) save.mutate();
      }}
    >
      <Card flush>
        <CardHeader title={t(`${kind}.title`)} />
        <CardBody>
          <div className="stack">
            {ORDER.map((weekday) => {
              const day = windows.map((w, index) => ({ w, index })).filter((x) => x.w.weekday === weekday);
              const dayName = fmt.weekday(weekday, 'long');
              return (
                <div key={weekday} className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                  <strong style={{ width: 96, paddingTop: 8 }}>{dayName}</strong>
                  <div className="stack stack--sm" style={{ flex: 1, minWidth: 260 }}>
                    {day.length === 0 ? (
                      <span className="t-secondary" style={{ paddingTop: 8 }}>
                        {t(`${kind}.empty`)}
                      </span>
                    ) : null}
                    {day.map(({ w, index }) => (
                      <div key={index} className="stack stack--sm">
                        <span className="row" style={{ gap: 8 }}>
                          <Select
                            className="ltr"
                            aria-label={t('window.fromLabel', { day: dayName })}
                            value={w.startMinute}
                            onChange={(e) => update(index, { startMinute: Number(e.target.value) })}
                          >
                            {options(false, w.startMinute).map((m) => (
                              <option key={m} value={m}>
                                {clock(m)}
                              </option>
                            ))}
                          </Select>
                          <span className="t-secondary">{t('window.to')}</span>
                          <Select
                            className="ltr"
                            aria-label={t('window.toLabel', { day: dayName })}
                            value={w.endMinute}
                            onChange={(e) => update(index, { endMinute: Number(e.target.value) })}
                          >
                            {options(true, w.endMinute).map((m) => (
                              <option key={m} value={m}>
                                {clock(m)}
                              </option>
                            ))}
                          </Select>
                          <Button
                            type="button"
                            size="sm"
                            variant="text"
                            iconOnly
                            icon={<Trash2 aria-hidden />}
                            aria-label={t('window.remove', { day: dayName, from: clock(w.startMinute), to: clock(w.endMinute) })}
                            onClick={() => setWindows(windows.filter((_, i) => i !== index))}
                          />
                        </span>
                        {error(index) ? <span className="field__error">{error(index)}</span> : null}
                      </div>
                    ))}
                  </div>
                  <Button type="button" size="sm" icon={<Plus aria-hidden />} disabled={day.length >= 4} onClick={() => add(weekday)}>
                    {c('add')}
                  </Button>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>
      {windows.length === 0 ? <Alert tone="warn">{t(`${kind}.none`)}</Alert> : null}
      {fieldError(save.error, 'windows') ? <Alert tone="error">{fieldError(save.error, 'windows')}</Alert> : null}
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="button" disabled={!dirty} onClick={() => setWindows(saved)}>
          {t('discard')}
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
          {t(`${kind}.save`)}
        </Button>
      </span>
    </form>
  );
}
