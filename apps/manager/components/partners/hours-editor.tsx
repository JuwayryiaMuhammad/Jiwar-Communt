'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Alert, Button, Card, CardBody, CardHeader, Select, useToast } from '@jiwar/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { clock, halfHours, sameWindows, sortWindows, WEEKDAYS, windowProblems, type Window } from '@/components/management-requests/logic';
import { api } from '@/lib/api';
import { keys, type StaffPartner } from '@/lib/queries';

/** Half hours, plus the saved value when it is off the grid. */
const options = (end: boolean, saved: number) => [...new Set([...halfHours(end), saved])].sort((a, b) => a - b);
/** Days in the order the week is worked here: Saturday first. */
const ORDER = [6, 0, 1, 2, 3, 4, 5];

/**
 * A partner's weekly hours (ADR 0060) in the compound's local time, saved
 * as a whole. Open past midnight is a window to 24:00 and the next day's
 * from 00:00; open all day is 00:00–24:00. "Open now" and "open late
 * tonight" read them.
 */
export function HoursEditor({ partner }: { partner: StaffPartner }) {
  const toast = useToast();
  const [windows, setWindows] = useState<Window[]>(partner.hours);
  const save = useAction(
    () =>
      unwrap(
        api.PUT('/api/v1/staff/partners/{id}/hours', {
          params: { path: { id: partner.id } },
          body: { windows: sortWindows(windows) },
        }),
      ),
    {
      invalidate: [keys.partnersAll],
      onDone: (next) => {
        setWindows(next.hours);
        toast.show('Hours saved.');
      },
    },
  );
  const problems = windowProblems(windows);
  const invalid = Object.keys(problems).length > 0;
  const dirty = !sameWindows(windows, partner.hours);
  const update = (index: number, patch: Partial<Window>) => setWindows(windows.map((w, i) => (i === index ? { ...w, ...patch } : w)));
  const add = (weekday: number) => {
    const last = Math.max(0, ...windows.filter((w) => w.weekday === weekday).map((w) => w.endMinute));
    const start = last ? Math.min(last, 1380) : 540;
    setWindows([...windows, { weekday, startMinute: start, endMinute: Math.min(start + (last ? 60 : 720), 1440) }]);
  };
  const allDay = () => setWindows(ORDER.map((weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })));
  const error = (index: number) =>
    problems[index] ?? fieldError(save.error, `windows.${index}.startMinute`) ?? fieldError(save.error, `windows.${index}.endMinute`);

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !invalid) save.mutate();
      }}
    >
      <Card flush>
        <CardHeader
          title="Hours"
          actions={
            <Button type="button" size="sm" onClick={allDay}>
              Open all day, every day
            </Button>
          }
        />
        <CardBody>
          <div className="stack">
            {ORDER.map((weekday) => {
              const day = windows.map((w, index) => ({ w, index })).filter((x) => x.w.weekday === weekday);
              return (
                <div key={weekday} className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                  <strong style={{ width: 96, paddingTop: 8 }}>{WEEKDAYS[weekday]}</strong>
                  <div className="stack stack--sm" style={{ flex: 1, minWidth: 260 }}>
                    {day.length === 0 ? (
                      <span className="t-secondary" style={{ paddingTop: 8 }}>
                        Closed
                      </span>
                    ) : null}
                    {day.map(({ w, index }) => (
                      <div key={index} className="stack stack--sm">
                        <span className="row" style={{ gap: 8 }}>
                          <Select
                            aria-label={`${WEEKDAYS[weekday]} from`}
                            value={w.startMinute}
                            onChange={(e) => update(index, { startMinute: Number(e.target.value) })}
                          >
                            {options(false, w.startMinute).map((m) => (
                              <option key={m} value={m}>
                                {clock(m)}
                              </option>
                            ))}
                          </Select>
                          <span className="t-secondary">to</span>
                          <Select
                            aria-label={`${WEEKDAYS[weekday]} to`}
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
                            aria-label={`Remove ${WEEKDAYS[weekday]} ${clock(w.startMinute)}–${clock(w.endMinute)}`}
                            onClick={() => setWindows(windows.filter((_, i) => i !== index))}
                          />
                        </span>
                        {error(index) ? <span className="field__error">{error(index)}</span> : null}
                      </div>
                    ))}
                  </div>
                  <Button type="button" size="sm" icon={<Plus aria-hidden />} disabled={day.length >= 4} onClick={() => add(weekday)}>
                    Add
                  </Button>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>
      {windows.length === 0 ? <Alert tone="warn">With no hours, the partner is never shown as open.</Alert> : null}
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="button" disabled={!dirty} onClick={() => setWindows(partner.hours)}>
          Discard
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
          Save hours
        </Button>
      </span>
    </form>
  );
}
