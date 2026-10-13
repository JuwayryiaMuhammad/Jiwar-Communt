'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
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
  welcomeProblems,
  type WelcomeForm,
  type WelcomeText,
} from '@/components/neighbours/logic';
import { api } from '@/lib/api';
import { fetchers, keys } from '@/lib/queries';

const LABEL: Record<'rules' | 'officeHours' | 'emergency', { label: string; rows: number }> = {
  rules: { label: 'The compound’s rules', rows: 8 },
  officeHours: { label: 'Office hours', rows: 3 },
  emergency: { label: 'Emergency numbers', rows: 3 },
};
const PARTS = ['rules', 'officeHours', 'emergency'] as const;

/**
 * What a household is shown when it moves in (ADR 0042): the rules, the
 * office hours and the emergency numbers, in English, Arabic or both.
 * Nothing is translated. A language is filled in completely or left empty;
 * with every text empty there is nothing to show and nobody is greeted.
 */
export function Welcome() {
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
        toast.show('The welcome is saved.');
      },
    },
  );
  const clear = useAction(() => unwrap(api.PUT('/api/v1/neighbours/welcome-template', { body: CLEARED_WELCOME })), {
    ...seed,
    onDone: (next) => {
      setForm(toWelcomeForm(next));
      setEnabled(next.enabled);
      setClearing(false);
      toast.show('The welcome texts are cleared.');
    },
  });

  const saved = template.data;
  if (!form || !saved) return <QueryState query={template}>{null}</QueryState>;
  const problems = welcomeProblems(form);
  const invalid = Object.keys(problems).length > 0;
  const dirty = enabled !== saved.enabled || !sameWelcome(form, saved);
  const savedHasText = welcomeHasText(toWelcomeForm(saved));

  const text = (part: (typeof PARTS)[number], language: 'En' | 'Ar') => {
    const key = `${part}${language}` as WelcomeText;
    return (
      <Field key={key} label={LABEL[part].label} error={fieldError(save.error, key) ?? problems[key]}>
        {(p) => (
          <Textarea
            {...p}
            {...(language === 'Ar' ? { dir: 'rtl' as const, lang: 'ar' } : {})}
            rows={LABEL[part].rows}
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
        <CardHeader title="Welcome for new households">
          <span className="t-secondary">Last changed {formatDateTime(saved.updatedAt)}.</span>
        </CardHeader>
        <CardBody>
          <div className="form">
            <Checkbox
              label="Greet a household when it moves in: its primary resident is pointed at this welcome"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <p className="t-secondary" style={{ margin: 0 }}>
              Write English, Arabic or both: a resident reads the language that was written, nothing is translated. A language is filled in
              completely or left empty.
            </p>
            {enabled && !welcomeHasText(form) ? <Alert tone="warn">Greeting is on, but every text is empty: there is nothing to show, so nobody is greeted.</Alert> : null}
          </div>
        </CardBody>
      </Card>
      <div className="grid grid--2" style={{ alignItems: 'start' }}>
        <Card flush>
          <CardHeader title="English" />
          <CardBody>
            <div className="form">{PARTS.map((part) => text(part, 'En'))}</div>
          </CardBody>
        </Card>
        <Card flush>
          <CardHeader title="Arabic" />
          <CardBody>
            <div className="form">{PARTS.map((part) => text(part, 'Ar'))}</div>
          </CardBody>
        </Card>
      </div>
      <div>
        <ErrorAlert error={save.error} />
        <span className="row" style={{ flexWrap: 'wrap' }}>
          <Button type="button" variant="danger" disabled={!savedHasText} onClick={() => setClearing(true)}>
            Clear
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
            Discard
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
            Save welcome
          </Button>
        </span>
      </div>
      <ConfirmDialog
        open={clearing}
        onClose={() => {
          setClearing(false);
          clear.reset();
        }}
        title="Clear the welcome?"
        description="All six saved texts are removed, in both languages. With nothing to show, no household is greeted until a welcome is written again."
        confirmLabel="Clear welcome"
        danger
        pending={clear.isPending}
        error={<ErrorAlert error={clear.error} />}
        onConfirm={() => clear.mutate()}
      />
    </form>
  );
}
