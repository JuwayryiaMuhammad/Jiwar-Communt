'use client';

import { fieldError, type Schema } from '@jiwar/api';
import { useFormat, useT } from '@jiwar/i18n';
import { Checkbox, Field, Input, Select, useLabel } from '@jiwar/ui';
import type { Preferences } from '@/lib/queries';
import ar from '@/messages/ar/shell-components';
import en from '@/messages/en/shell-components';

const CATEGORIES = [
  'maintenance',
  'gate_visitors',
  'parcels',
  'household',
  'account_security',
  'management',
  'community',
  'neighbours',
  'bookings',
  'safety',
  'permits',
  'governance',
  'partners',
  'utilities',
  'market',
] as const;
type Category = (typeof CATEGORIES)[number];
const isCategory = (c: string): c is Category => (CATEGORIES as readonly string[]).includes(c);

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
  error,
}: {
  saved: Preferences;
  form: PrefsForm;
  onChange: (form: PrefsForm) => void;
  own?: boolean;
  /** The save's error: a refused quiet-hours window is explained at its field. */
  error?: unknown;
}) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  return (
    <>
      <div className="stack stack--sm">
        {saved.categories.map((c) => (
          <span key={c.category} className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <span style={{ minWidth: 170 }}>{isCategory(c.category) ? t(`category.${c.category}`) : label(c.category)}</span>
            {(['email', 'push'] as const).map((channel) => (
              <Checkbox
                key={channel}
                label={t(`channel.${channel}`)}
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
        label={t('quietHours', { own: own ? 'yes' : 'no', zone: saved.timeZone })}
        checked={form.quiet}
        onChange={(e) => onChange({ ...form, quiet: e.target.checked })}
      />
      {form.quiet ? (
        <div className="form__row">
          <Field label={t('quietFrom')}>
            {(p) => <Input {...p} type="time" value={form.start} onChange={(e) => onChange({ ...form, start: e.target.value })} />}
          </Field>
          <Field
            label={t('quietUntil')}
            hint={t('quietUntilHint')}
            error={fieldError(error, 'quietHours') ? t('quietSame') : undefined}
          >
            {(p) => <Input {...p} type="time" value={form.end} onChange={(e) => onChange({ ...form, end: e.target.value })} />}
          </Field>
        </div>
      ) : null}
      <Field
        label={t('pause')}
        hint={
          saved.pause
            ? saved.pause.until
              ? t('pausedUntil', { when: fmt.dateTime(saved.pause.until) })
              : t('pausedUntilResumed')
            : t('notPaused')
        }
      >
        {(p) => (
          <Select {...p} value={form.pause} onChange={(e) => onChange({ ...form, pause: e.target.value as Pause })}>
            <option value="">{t('pause.keep')}</option>
            <option value="1h">{t('pause.1h')}</option>
            <option value="8h">{t('pause.8h')}</option>
            <option value="until_resumed">{t('pause.until_resumed')}</option>
            {saved.pause ? <option value="resume">{t('pause.resume')}</option> : null}
          </Select>
        )}
      </Field>
    </>
  );
}
