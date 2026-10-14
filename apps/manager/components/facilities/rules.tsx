'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Select, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type CapacityUnit, type Facility, type FacilityRules } from '@/lib/queries';
import { inRange, minutesText, numberChanges, peakProblem, RULE_FIELDS, RULE_RANGES, type RuleField } from './logic';

type Form = Record<RuleField, string> & { capacityUnit: CapacityUnit; requiresApproval: boolean; requiresMembership: boolean };

const toForm = (r: FacilityRules): Form => ({
  ...(Object.fromEntries(RULE_FIELDS.map((k) => [k, String(r[k])])) as Record<RuleField, string>),
  capacityUnit: r.capacityUnit,
  requiresApproval: r.requiresApproval,
  requiresMembership: r.requiresMembership,
});

const COPY: Record<RuleField, { label: string; hint: string }> = {
  slotMinutes: { label: 'Slot length, minutes', hint: 'The opening hours are cut into slots this long.' },
  capacity: { label: 'Capacity of a slot', hint: 'In bookings, or in people (each booker and their guests).' },
  maxDaysAhead: { label: 'Days ahead', hint: 'How many local days ahead a slot may be booked.' },
  minMinutesBefore: { label: 'Notice, minutes', hint: 'A booking starts at least this long after it is made.' },
  cancelCutoffMinutes: { label: 'Cancellation cutoff, minutes', hint: 'Residents cancel a confirmed booking at least this long before it starts. The staff may cancel any time.' },
  maxGuests: { label: 'Guests per booking', hint: 'Beside the booker. A number only: guests are never named.' },
  weeklyQuota: { label: 'Bookings per unit in any 7 days', hint: 'Pending, confirmed and no-shows count; cancelled and rejected ones do not.' },
  peakQuota: { label: 'Peak-time bookings per unit in any 7 days', hint: 'At most the weekly quota.' },
};

/**
 * How a bookable facility is booked (ADR 0044). Only what changed is sent.
 * Bookings already made keep their slot whatever the rules become.
 */
export function Rules({ facility, rules }: { facility: Facility; rules: FacilityRules }) {
  const toast = useToast();
  const [form, setForm] = useState<Form>(toForm(rules));
  const invalid = RULE_FIELDS.some((k) => !inRange(RULE_RANGES[k], form[k])) || peakProblem(form.weeklyQuota, form.peakQuota) !== undefined;
  const changes = {
    ...(invalid ? {} : numberChanges(form, rules, RULE_FIELDS)),
    ...(form.capacityUnit !== rules.capacityUnit ? { capacityUnit: form.capacityUnit } : {}),
    ...(form.requiresApproval !== rules.requiresApproval ? { requiresApproval: form.requiresApproval } : {}),
    ...(form.requiresMembership !== rules.requiresMembership ? { requiresMembership: form.requiresMembership } : {}),
  };
  const dirty = Object.keys(changes).length > 0;
  const save = useAction(() => unwrap(api.PATCH('/api/v1/staff/facilities/{id}', { params: { path: { id: facility.id } }, body: changes })), {
    invalidate: [keys.facilitiesAll],
    onDone: (next) => {
      if (next.rules) setForm(toForm(next.rules));
      toast.show('Rules saved.');
    },
  });

  const field = (key: RuleField) => {
    const { min, max } = RULE_RANGES[key];
    const local = inRange(RULE_RANGES[key], form[key])
      ? key === 'peakQuota'
        ? peakProblem(form.weeklyQuota, form.peakQuota)
        : undefined
      : `A whole number from ${min} to ${max}.`;
    const value = Number(form[key]);
    const hint =
      (key === 'minMinutesBefore' || key === 'cancelCutoffMinutes') && inRange(RULE_RANGES[key], form[key])
        ? `${COPY[key].hint} Now: ${minutesText(value)}.`
        : COPY[key].hint;
    return (
      <Field label={COPY[key].label} hint={hint} error={fieldError(save.error, key) ?? local}>
        {(p) => <Input {...p} type="number" min={min} max={max} step={1} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />}
      </Field>
    );
  };

  return (
    <form
      className="grid grid--2"
      style={{ alignItems: 'start' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !invalid) save.mutate();
      }}
    >
      <Card flush>
        <CardHeader title="Slots" />
        <CardBody>
          <div className="form">
            {field('slotMinutes')}
            {field('capacity')}
            <Field label="Capacity counts" hint="A court takes bookings; a hall takes people.">
              {(p) => (
                <Select {...p} value={form.capacityUnit} onChange={(e) => setForm({ ...form, capacityUnit: e.target.value as CapacityUnit })}>
                  <option value="bookings">Bookings</option>
                  <option value="people">People</option>
                </Select>
              )}
            </Field>
            {field('maxGuests')}
          </div>
        </CardBody>
      </Card>
      <Card flush>
        <CardHeader title="When" />
        <CardBody>
          <div className="form">
            {field('maxDaysAhead')}
            {field('minMinutesBefore')}
            {field('cancelCutoffMinutes')}
          </div>
        </CardBody>
      </Card>
      <Card flush>
        <CardHeader title="Fairness" />
        <CardBody>
          <div className="form">
            {field('weeklyQuota')}
            {field('peakQuota')}
          </div>
        </CardBody>
      </Card>
      <Card flush>
        <CardHeader title="Who" />
        <CardBody>
          <div className="form">
            <Checkbox
              label="Bookings wait for the management’s approval (they hold their place meanwhile)"
              checked={form.requiresApproval}
              onChange={(e) => setForm({ ...form, requiresApproval: e.target.checked })}
            />
            <Checkbox
              label="For club members only: the unit’s membership must be active and cover the booker"
              checked={form.requiresMembership}
              onChange={(e) => setForm({ ...form, requiresMembership: e.target.checked })}
            />
          </div>
        </CardBody>
      </Card>
      <div className="stack" style={{ gridColumn: '1 / -1' }}>
        <ErrorAlert error={save.error} />
        <span className="row">
          <span className="spacer" />
          <Button type="button" disabled={!dirty} onClick={() => setForm(toForm(rules))}>
            Discard
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
            Save rules
          </Button>
        </span>
      </div>
    </form>
  );
}
