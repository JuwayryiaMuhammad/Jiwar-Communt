'use client';

import { useId, useState } from 'react';
import { post } from '@/lib/client';
import { fieldErrorKey, type FieldError } from '@/lib/errors';
import { RULES } from '@/lib/flow';
import { completionBody, emptyForm, isCode, registrationBody, type RegistrationBody, type RegistrationForm } from '@/lib/registration';
import type { MessageKey } from '@/messages/ar';
import { CodeField } from './code-field';
import { useLocale } from './locale';
import { ErrorNote, InvalidLink, Loading, Shell } from './shell';
import { useFlow } from './use-flow';
import { useLinkToken } from './use-link-token';

const UNIT_TYPES = ['apartment', 'villa', 'townhouse', 'duplex', 'penthouse', 'studio', 'commercial', 'other'] as const;

function Field({
  label,
  hint,
  errors,
  name,
  children,
}: {
  label: string;
  hint?: string;
  errors: FieldError[];
  name: string;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) => React.ReactNode;
}) {
  const { t } = useLocale();
  const id = useId();
  const mine = errors.filter((e) => e.field === name);
  const described = [hint ? `${id}-hint` : '', mine.length ? `${id}-error` : ''].filter(Boolean).join(' ');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, ...(described ? { 'aria-describedby': described } : {}), ...(mine.length ? { 'aria-invalid': true } : {}) })}
      {hint ? (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      ) : null}
      {mine.length ? (
        <p id={`${id}-error`} className="note note--error">
          {mine.map((e) => t(fieldErrorKey(e.code), e.params)).join(' ')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * /r: self-registration (ADR 0024). The form is sent twice: to get a code,
 * and again with the code. The second body is the first one, frozen.
 */
export function RegistrationPage() {
  const { t, locale } = useLocale();
  const link = useLinkToken('registration');
  const { state, run, dispatch } = useFlow(RULES.registration);
  const [form, setForm] = useState<RegistrationForm>(emptyForm);
  const [sent, setSent] = useState<RegistrationBody | null>(null);
  const [code, setCode] = useState('');

  if (link.state === 'reading') return <Loading />;
  if (link.state === 'missing' || state.step === 'dead') return <InvalidLink />;
  const { token } = link;

  const set = <K extends keyof RegistrationForm>(key: K, value: RegistrationForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const start = (body: RegistrationBody) => {
    setCode('');
    void run(() => post('registrations/start', body, locale), 'code', () => setSent(body));
  };

  if (state.step === 'done') {
    return (
      <Shell title={t('reg.done.title')}>
        <p role="status">{t('reg.done.body')}</p>
      </Shell>
    );
  }

  if (state.step === 'code' && sent) {
    return (
      <Shell title={t('reg.title')}>
        <p role="status">{t('reg.sent', { email: String(sent.email) })}</p>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!isCode(code)) return;
            void run(() => post('registrations/complete', completionBody(sent, code), locale), 'done');
          }}
        >
          <CodeField value={code} onChange={setCode} disabled={state.busy} />
          <ErrorNote code={state.error} />
          <button type="submit" className="button" disabled={state.busy || !isCode(code)}>
            {t('reg.submit')}
          </button>
          <button type="button" className="button button--quiet" disabled={state.busy} onClick={() => start(sent)}>
            {t('common.resend')}
          </button>
          <button type="button" className="button button--quiet" disabled={state.busy} onClick={() => dispatch({ type: 'edit' })}>
            {t('reg.edit')}
          </button>
        </form>
      </Shell>
    );
  }

  const passport = form.idDocumentType === 'passport';
  const errors = state.fields;
  const text = (key: keyof RegistrationForm) => ({
    className: 'input',
    value: form[key] as string,
    disabled: state.busy,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value as never),
  });

  return (
    <Shell title={t('reg.title')}>
      <p>{t('reg.intro')}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          start(registrationBody(token, form, locale));
        }}
      >
        <Field label={t('reg.fullName')} name="fullName" errors={errors}>
          {(p) => <input {...p} {...text('fullName')} autoComplete="name" required minLength={2} maxLength={200} />}
        </Field>
        <Field label={t('reg.unitCode')} hint={t('reg.unitCode.hint')} name="unitCode" errors={errors}>
          {(p) => <input {...p} {...text('unitCode')} dir="ltr" autoCapitalize="characters" required maxLength={50} />}
        </Field>
        <Field label={t('reg.phone')} name="phone" errors={errors}>
          {(p) => <input {...p} {...text('phone')} dir="ltr" type="tel" inputMode="tel" autoComplete="tel" required />}
        </Field>
        <Field label={t('reg.email')} name="email" errors={errors}>
          {(p) => <input {...p} {...text('email')} dir="ltr" type="email" inputMode="email" autoComplete="email" required />}
        </Field>
        <Field label={t('reg.idType')} name="idDocumentType" errors={errors}>
          {(p) => (
            <select
              {...p}
              className="input"
              value={form.idDocumentType}
              disabled={state.busy}
              onChange={(e) => set('idDocumentType', e.target.value as RegistrationForm['idDocumentType'])}
            >
              <option value="national_id">{t('reg.idType.national_id')}</option>
              <option value="passport">{t('reg.idType.passport')}</option>
            </select>
          )}
        </Field>
        <Field label={t('reg.idNumber')} name="idDocumentNumber" errors={errors}>
          {(p) => <input {...p} {...text('idDocumentNumber')} dir="ltr" inputMode={passport ? 'text' : 'numeric'} required maxLength={20} />}
        </Field>
        {passport ? (
          <>
            <Field label={t('reg.nationality')} hint={t('reg.nationality.hint')} name="nationality" errors={errors}>
              {(p) => <input {...p} {...text('nationality')} dir="ltr" autoCapitalize="characters" required minLength={2} maxLength={2} />}
            </Field>
            <Field label={t('reg.birthDate')} name="birthDate" errors={errors}>
              {(p) => <input {...p} {...text('birthDate')} dir="ltr" type="date" autoComplete="bday" required />}
            </Field>
          </>
        ) : null}
        <Field label={t('reg.occupancy')} name="occupancyType" errors={errors}>
          {(p) => (
            <select
              {...p}
              className="input"
              value={form.occupancyType}
              disabled={state.busy}
              onChange={(e) => set('occupancyType', e.target.value as RegistrationForm['occupancyType'])}
            >
              <option value="owner">{t('reg.occupancy.owner')}</option>
              <option value="tenant">{t('reg.occupancy.tenant')}</option>
            </select>
          )}
        </Field>
        {form.occupancyType === 'owner' ? (
          <label className="check">
            <input type="checkbox" checked={form.resides} disabled={state.busy} onChange={(e) => set('resides', e.target.checked)} />
            <span>{t('reg.resides')}</span>
          </label>
        ) : null}

        <fieldset className="group">
          <legend>{t('reg.optional')}</legend>
          <Field label={t('reg.unitType')} name="unitType" errors={errors}>
            {(p) => (
              <select {...p} className="input" value={form.unitType} disabled={state.busy} onChange={(e) => set('unitType', e.target.value)}>
                <option value="">{t('reg.unitType.none')}</option>
                {UNIT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`reg.unitType.${type}` satisfies MessageKey)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('reg.areaSqm')} name="areaSqm" errors={errors}>
            {(p) => <input {...p} {...text('areaSqm')} dir="ltr" inputMode="decimal" maxLength={9} />}
          </Field>
          <Field label={t('reg.building')} name="building" errors={errors}>
            {(p) => <input {...p} {...text('building')} maxLength={50} />}
          </Field>
        </fieldset>

        <ErrorNote code={state.error} />
        <button type="submit" className="button" disabled={state.busy}>
          {t('reg.send')}
        </button>
      </form>
    </Shell>
  );
}
