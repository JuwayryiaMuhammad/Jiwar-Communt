'use client';

import { formatDateTime, humanize, type Schema } from '@jiwar/api';
import { Checkbox, Field, Input, Select } from '@jiwar/ui';
import { NOTIFICATION_CATEGORY_TEXT } from '@/components/accounts/labels';
import type { Preferences } from '@/lib/queries';

type Pause = '' | '1h' | '8h' | 'until_resumed' | 'resume';
export interface PrefsForm {
  categories: Record<string, { email: boolean; push: boolean }>;
  quiet: boolean;
  start: string;
  end: string;
  pause: Pause;
}
export const toForm = (p: Preferences): PrefsForm => ({
  categories: Object.fromEntries(p.categories.map((c) => [c.category, { email: c.email, push: c.push }])),
  quiet: p.quietHours !== null,
  start: p.quietHours?.start ?? '22:00',
  end: p.quietHours?.end ?? '07:00',
  pause: '',
});

/** Only what changed is sent; null when nothing did. */
export function preferencesChanges(saved: Preferences, form: PrefsForm): Schema<'UpdatePreferencesDto'> | null {
  const categories = saved.categories
    .filter((c) => form.categories[c.category]?.email !== c.email || form.categories[c.category]?.push !== c.push)
    .map((c) => ({ category: c.category, ...form.categories[c.category]! }));
  const quietChanged =
    form.quiet !== (saved.quietHours !== null) ||
    (form.quiet && (form.start !== saved.quietHours?.start || form.end !== saved.quietHours?.end));
  if (categories.length === 0 && !quietChanged && form.pause === '') return null;
  return {
    ...(categories.length ? { categories } : {}),
    ...(quietChanged ? { quietHours: form.quiet ? { start: form.start, end: form.end } : null } : {}),
    ...(form.pause === 'resume' ? { pause: null } : form.pause ? { pause: form.pause } : {}),
  };
}

/**
 * The delivery switches of an account (ADR 0036): per category and channel,
 * quiet hours and a pause. The same fields for a manager's own account and
 * for one a manager acts for; `own` only changes whose time zone is named.
 */
export function PreferencesFields({
  saved,
  form,
  onChange,
  own,
}: {
  saved: Preferences;
  form: PrefsForm;
  onChange: (form: PrefsForm) => void;
  own?: boolean;
}) {
  return (
    <>
      <div className="stack stack--sm">
        {saved.categories.map((c) => (
          <span key={c.category} className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <span style={{ minWidth: 170 }}>{NOTIFICATION_CATEGORY_TEXT[c.category] ?? humanize(c.category)}</span>
            {(['email', 'push'] as const).map((channel) => (
              <Checkbox
                key={channel}
                label={channel === 'email' ? 'Email' : 'Push'}
                checked={form.categories[c.category]?.[channel] ?? false}
                onChange={(e) =>
                  onChange({
                    ...form,
                    categories: { ...form.categories, [c.category]: { ...form.categories[c.category]!, [channel]: e.target.checked } },
                  })
                }
              />
            ))}
          </span>
        ))}
      </div>
      <Checkbox
        label={`Quiet hours: hold non-urgent notices at night (${own ? "the compound's" : 'their'} time zone, ${saved.timeZone})`}
        checked={form.quiet}
        onChange={(e) => onChange({ ...form, quiet: e.target.checked })}
      />
      {form.quiet ? (
        <div className="form__row">
          <Field label="Quiet from">
            {(p) => <Input {...p} type="time" value={form.start} onChange={(e) => onChange({ ...form, start: e.target.value })} />}
          </Field>
          <Field label="Quiet until" hint="Before the start: the window runs past midnight.">
            {(p) => <Input {...p} type="time" value={form.end} onChange={(e) => onChange({ ...form, end: e.target.value })} />}
          </Field>
        </div>
      ) : null}
      <Field
        label="Pause"
        hint={
          saved.pause
            ? saved.pause.until
              ? `Paused now, until ${formatDateTime(saved.pause.until)}.`
              : 'Paused now, until resumed.'
            : 'Not paused now.'
        }
      >
        {(p) => (
          <Select {...p} value={form.pause} onChange={(e) => onChange({ ...form, pause: e.target.value as Pause })}>
            <option value="">Leave as it is</option>
            <option value="1h">Pause for 1 hour</option>
            <option value="8h">Pause for 8 hours</option>
            <option value="until_resumed">Pause until resumed</option>
            {saved.pause ? <option value="resume">Resume now</option> : null}
          </Select>
        )}
      </Field>
    </>
  );
}
