'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Select, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type CapacityUnit, type Facility, type FacilityRules } from '@/lib/queries';
import ar from '@/messages/ar/places-facilities';
import en from '@/messages/en/places-facilities';
import { inRange, minutesText, numberChanges, peakAboveWeekly, RULE_FIELDS, RULE_RANGES, type RuleField } from './logic';

type Form = Record<RuleField, string> & {
  capacityUnit: CapacityUnit;
  requiresApproval: boolean;
  requiresMembership: boolean;
  childOccasions: boolean;
};

const toForm = (r: FacilityRules): Form => ({
  ...(Object.fromEntries(RULE_FIELDS.map((k) => [k, String(r[k])])) as Record<RuleField, string>),
  capacityUnit: r.capacityUnit,
  requiresApproval: r.requiresApproval,
  requiresMembership: r.requiresMembership,
  childOccasions: r.childOccasions,
});

/**
 * How a bookable facility is booked (ADR 0044). Only what changed is sent.
 * Bookings already made keep their slot whatever the rules become.
 */
export function Rules({ facility, rules }: { facility: Facility; rules: FacilityRules }) {
  const t = useT(en, ar);
  const toast = useToast();
  const [form, setForm] = useState<Form>(toForm(rules));
  const invalid = RULE_FIELDS.some((k) => !inRange(RULE_RANGES[k], form[k])) || peakAboveWeekly(form.weeklyQuota, form.peakQuota);
  const changes = {
    ...(invalid ? {} : numberChanges(form, rules, RULE_FIELDS)),
    ...(form.capacityUnit !== rules.capacityUnit ? { capacityUnit: form.capacityUnit } : {}),
    ...(form.requiresApproval !== rules.requiresApproval ? { requiresApproval: form.requiresApproval } : {}),
    ...(form.requiresMembership !== rules.requiresMembership ? { requiresMembership: form.requiresMembership } : {}),
    ...(form.childOccasions !== rules.childOccasions ? { childOccasions: form.childOccasions } : {}),
  };
  const dirty = Object.keys(changes).length > 0;
  const save = useAction(() => unwrap(api.PATCH('/api/v1/staff/facilities/{id}', { params: { path: { id: facility.id } }, body: changes })), {
    invalidate: [keys.facilitiesAll],
    onDone: (next) => {
      if (next.rules) setForm(toForm(next.rules));
      toast.show(t('rulesSaved'));
    },
  });

  const field = (key: RuleField) => {
    const { min, max } = RULE_RANGES[key];
    const local = inRange(RULE_RANGES[key], form[key])
      ? key === 'peakQuota' && peakAboveWeekly(form.weeklyQuota, form.peakQuota)
        ? t('peakAboveWeekly')
        : undefined
      : t('wholeRange', { min, max });
    const value = Number(form[key]);
    const hint =
      key === 'minMinutesBefore' || key === 'cancelCutoffMinutes'
        ? inRange(RULE_RANGES[key], form[key])
          ? t(`rule.${key}.hintNow`, { now: minutesText(value, t) })
          : t(`rule.${key}.hint`)
        : t(`rule.${key}.hint`);
    return (
      <Field label={t(`rule.${key}`)} hint={hint} error={fieldError(save.error, key) ?? local}>
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
        <CardHeader title={t('card.slots')} />
        <CardBody>
          <div className="form">
            {field('slotMinutes')}
            {field('capacity')}
            <Field label={t('capacityCounts')} hint={t('capacityCountsHint')}>
              {(p) => (
                <Select {...p} value={form.capacityUnit} onChange={(e) => setForm({ ...form, capacityUnit: e.target.value as CapacityUnit })}>
                  <option value="bookings">{t('capacityUnit.bookings')}</option>
                  <option value="people">{t('capacityUnit.people')}</option>
                </Select>
              )}
            </Field>
            {field('maxGuests')}
          </div>
        </CardBody>
      </Card>
      <Card flush>
        <CardHeader title={t('card.when')} />
        <CardBody>
          <div className="form">
            {field('maxDaysAhead')}
            {field('minMinutesBefore')}
            {field('cancelCutoffMinutes')}
          </div>
        </CardBody>
      </Card>
      <Card flush>
        <CardHeader title={t('card.fairness')} />
        <CardBody>
          <div className="form">
            {field('weeklyQuota')}
            {field('peakQuota')}
          </div>
        </CardBody>
      </Card>
      <Card flush>
        <CardHeader title={t('card.who')} />
        <CardBody>
          <div className="form">
            <Checkbox
              label={t('requiresApproval')}
              checked={form.requiresApproval}
              onChange={(e) => setForm({ ...form, requiresApproval: e.target.checked })}
            />
            <Checkbox
              label={t('requiresMembership')}
              checked={form.requiresMembership}
              onChange={(e) => setForm({ ...form, requiresMembership: e.target.checked })}
            />
            <Checkbox
              label={t('childOccasions')}
              checked={form.childOccasions}
              onChange={(e) => setForm({ ...form, childOccasions: e.target.checked })}
            />
          </div>
        </CardBody>
      </Card>
      <div className="stack" style={{ gridColumn: '1 / -1' }}>
        <ErrorAlert error={save.error} />
        <span className="row">
          <span className="spacer" />
          <Button type="button" disabled={!dirty} onClick={() => setForm(toForm(rules))}>
            {t('discard')}
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
            {t('saveRules')}
          </Button>
        </span>
      </div>
    </form>
  );
}
