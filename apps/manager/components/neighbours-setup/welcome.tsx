'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Button, Card, CardBody, CardHeader, Checkbox, ConfirmDialog, Field, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  CLEARED_WELCOME,
  sameWelcome,
  toWelcomeForm,
  WELCOME_MAX,
  welcomeBody,
  welcomeHasText,
  type WelcomeForm,
  type WelcomeText,
} from '@/components/neighbours/logic';
import { api } from '@/lib/api';
import { welcomeProblemCodes } from '@/components/neighbours/words';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/neighbours-setup';
import en from '@/messages/en/neighbours-setup';

const ROWS: Record<'rules' | 'officeHours' | 'emergency', number> = { rules: 8, officeHours: 3, emergency: 3 };
const PARTS = ['rules', 'officeHours', 'emergency'] as const;

/**
 * What a household is shown when it moves in (ADR 0042): the rules, the
 * office hours and the emergency numbers, in English, Arabic or both.
 * Nothing is translated. A language is filled in completely or left empty;
 * with every text empty there is nothing to show and nobody is greeted.
 */
export function Welcome() {
  const t = useT(en, ar);
  const f = useFormat();
  const toast = useToast();
  const template = useQuery({ queryKey: keys.welcomeTemplate, queryFn: fetchers.welcomeTemplate });
  const [form, setForm] = useState<WelcomeForm | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [clearing, setClearing] = useState(false);
  // Seed once: a background refetch must not wipe unsaved edits.
  useEffect(() => {
    if (template.data && form === null) {
      setForm(toWelcomeForm(template.data));
      setEnabled(template.data.enabled);
    }
  }, [template.data, form]);

  const seed = { invalidate: [keys.welcomeTemplate] };
  const save = useAction(
    () => unwrap(api.PUT('/api/v1/neighbours/welcome-template', { body: { enabled, ...(form ? welcomeBody(form) : {}) } })),
    {
      ...seed,
      onDone: (next) => {
        setForm(toWelcomeForm(next));
        setEnabled(next.enabled);
        toast.show(t('welcome.saved'));
      },
    },
  );
  const clear = useAction(() => unwrap(api.PUT('/api/v1/neighbours/welcome-template', { body: CLEARED_WELCOME })), {
    ...seed,
    onDone: (next) => {
      setForm(toWelcomeForm(next));
      setEnabled(next.enabled);
      setClearing(false);
      toast.show(t('welcome.cleared'));
    },
  });

  const saved = template.data;
  if (!form || !saved) return <QueryState query={template}>{null}</QueryState>;
  const problems = welcomeProblemCodes(form);
  const invalid = Object.keys(problems).length > 0;
  const dirty = enabled !== saved.enabled || !sameWelcome(form, saved);
  const savedHasText = welcomeHasText(toWelcomeForm(saved));

  const text = (part: (typeof PARTS)[number], language: 'En' | 'Ar') => {
    const key = `${part}${language}` as WelcomeText;
    const problem = problems[key];
    return (
      <Field
        key={key}
        label={t(`welcome.${part}`)}
        error={fieldError(save.error, key) ?? (problem ? t(`welcome.problem.${problem}`, { max: f.number(WELCOME_MAX[key]) }) : undefined)}
      >
        {(p) => (
          <Textarea
            {...p}
            {...(language === 'Ar' ? { dir: 'rtl' as const, lang: 'ar' } : {})}
            rows={ROWS[part]}
            maxLength={WELCOME_MAX[key]}
            value={form[key]}
            onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          />
        )}
      </Field>
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
        <CardHeader title={t('welcome.title')}>
          <span className="t-secondary">{t('welcome.lastChanged', { date: f.dateTime(saved.updatedAt) })}</span>
        </CardHeader>
        <CardBody>
          <div className="form">
            <Checkbox
              label={t('welcome.enabled')}
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <p className="t-secondary" style={{ margin: 0 }}>
              {t('welcome.note')}
            </p>
            {enabled && !welcomeHasText(form) ? <Alert tone="warn">{t('welcome.emptyWarning')}</Alert> : null}
          </div>
        </CardBody>
      </Card>
      <div className="grid grid--2" style={{ alignItems: 'start' }}>
        <Card flush>
          <CardHeader title={t('welcome.english')} />
          <CardBody>
            <div className="form">{PARTS.map((part) => text(part, 'En'))}</div>
          </CardBody>
        </Card>
        <Card flush>
          <CardHeader title={t('welcome.arabic')} />
          <CardBody>
            <div className="form">{PARTS.map((part) => text(part, 'Ar'))}</div>
          </CardBody>
        </Card>
      </div>
      <div>
        <ErrorAlert error={save.error} />
        <span className="row" style={{ flexWrap: 'wrap' }}>
          <Button type="button" variant="danger" disabled={!savedHasText} onClick={() => setClearing(true)}>
            {t('welcome.clear')}
          </Button>
          <span className="spacer" />
          <Button
            type="button"
            disabled={!dirty}
            onClick={() => {
              setForm(toWelcomeForm(saved));
              setEnabled(saved.enabled);
            }}
          >
            {t('discard')}
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
            {t('welcome.save')}
          </Button>
        </span>
      </div>
      <ConfirmDialog
        open={clearing}
        onClose={() => {
          setClearing(false);
          clear.reset();
        }}
        title={t('welcome.clearTitle')}
        description={t('welcome.clearDescription')}
        confirmLabel={t('welcome.clearConfirm')}
        danger
        pending={clear.isPending}
        error={<ErrorAlert error={clear.error} />}
        onConfirm={() => clear.mutate()}
      />
    </form>
  );
}
