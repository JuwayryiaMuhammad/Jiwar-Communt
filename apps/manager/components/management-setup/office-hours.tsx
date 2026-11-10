'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Button, Card, CardBody, CardHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { clock, halfHours, sameWindows, slotsPerWeek, sortWindows, windowProblemCodes, type Window } from '@/components/management-requests/logic';
import { api } from '@/lib/api';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/services-mgmt-setup';
import en from '@/messages/en/services-mgmt-setup';

/** Half hours, plus the saved value when it is off the grid. */
const options = (end: boolean, saved: number) => [...new Set([...halfHours(end), saved])].sort((a, b) => a - b);
/** Days in the order the week is worked here: Saturday first. */
const ORDER = [6, 0, 1, 2, 3, 4, 5];

/**
 * The office hours (ADR 0039): weekly windows in the compound's local time
 * (its time zone is on the Settings page), from which appointment slots
 * are cut. The whole week is saved at once. Appointments already booked
 * keep their time whatever the hours become.
 */
export function OfficeHours() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const toast = useToast();
  const hours = useQuery({ queryKey: keys.officeHours, queryFn: fetchers.officeHours });
  const settings = useQuery({ queryKey: keys.requestSettings, queryFn: fetchers.requestSettings });
  const [windows, setWindows] = useState<Window[] | null>(null);
  // Seed once: a background refetch must not wipe unsaved edits.
  useEffect(() => {
    if (hours.data && windows === null) setWindows(hours.data.windows);
  }, [hours.data, windows]);

  const save = useAction(() => unwrap(api.PUT('/api/v1/management/office-hours', { body: { windows: sortWindows(windows ?? []) } })), {
    invalidate: [keys.officeHours, keys.managementAll],
    onDone: (next) => {
      setWindows(next.windows);
      toast.show(t('hoursSaved'));
    },
  });

  if (!windows || !hours.data) return <QueryState query={hours}>{null}</QueryState>;
  const problems = windowProblemCodes(windows);
  const invalid = Object.keys(problems).length > 0;
  const dirty = !sameWindows(windows, hours.data.windows);
  const update = (index: number, patch: Partial<Window>) => setWindows(windows.map((w, i) => (i === index ? { ...w, ...patch } : w)));
  const add = (weekday: number) => {
    // After the day's last window, an hour long where the day allows.
    const last = Math.max(0, ...windows.filter((w) => w.weekday === weekday).map((w) => w.endMinute));
    const start = last ? Math.min(last, 1380) : 540;
    setWindows([...windows, { weekday, startMinute: start, endMinute: last ? Math.min(start + 60, 1440) : 1020 }]);
  };
  const slotMinutes = settings.data?.appointmentSlotMinutes;

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !invalid) save.mutate();
      }}
    >
      <Card flush>
        <CardHeader title={t('weekly')} />
        <CardBody>
          <div className="stack">
            {ORDER.map((weekday) => {
              const day = windows.map((w, index) => ({ w, index })).filter((x) => x.w.weekday === weekday);
              const dayName = fmt.weekday(weekday, 'long');
              return (
                <div key={weekday} className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                  <strong style={{ width: 96, paddingBlockStart: 8 }}>{dayName}</strong>
                  <div className="stack stack--sm" style={{ flex: 1, minWidth: 260 }}>
                    {day.length === 0 ? (
                      <span className="t-secondary" style={{ paddingBlockStart: 8 }}>
                        {t('closed')}
                      </span>
                    ) : null}
                    {day.map(({ w, index }) => (
                      <div key={index} className="stack stack--sm">
                        <span className="row" style={{ gap: 8 }}>
                          <Select
                            aria-label={t('fromLabel', { day: dayName })}
                            value={w.startMinute}
                            onChange={(e) => update(index, { startMinute: Number(e.target.value) })}
                          >
                            {options(false, w.startMinute).map((m) => (
                              <option key={m} value={m}>
                                {clock(m)}
                              </option>
                            ))}
                          </Select>
                          <span className="t-secondary">{t('to')}</span>
                          <Select
                            aria-label={t('toLabel', { day: dayName })}
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
                            aria-label={t('removeWindow', { day: dayName, from: clock(w.startMinute), to: clock(w.endMinute) })}
                            onClick={() => setWindows(windows.filter((_, i) => i !== index))}
                          />
                        </span>
                        {problems[index] || fieldError(save.error, `windows.${index}.startMinute`) || fieldError(save.error, `windows.${index}.endMinute`) ? (
                          <span className="field__error">
                            {(problems[index] ? t(`problem.${problems[index]}`) : undefined) ??
                              fieldError(save.error, `windows.${index}.startMinute`) ??
                              fieldError(save.error, `windows.${index}.endMinute`)}
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <Button type="button" size="sm" icon={<Plus aria-hidden />} disabled={day.length >= 4} onClick={() => add(weekday)}>
                    {t('addHours')}
                  </Button>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>
      {windows.length === 0 ? (
        <Alert tone="warn">{t('noHours')}</Alert>
      ) : slotMinutes ? (
        <p className="t-secondary">{t('slotsLine', { n: slotsPerWeek(windows, slotMinutes), minutes: slotMinutes })}</p>
      ) : null}
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="button" disabled={!dirty} onClick={() => setWindows(hours.data.windows)}>
          {t('discard')}
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
          {t('saveHours')}
        </Button>
      </span>
    </form>
  );
}
