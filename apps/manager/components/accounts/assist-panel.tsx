'use client';

import { ApiError, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Field, Input, ReasonCodeDialog, Select, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { keys, type Consent, type Preferences } from '@/lib/queries';
import { BLOCKER_TEXT, CONSENT_TEXT, NOTIFICATION_CATEGORY_TEXT } from './labels';

type Pause = '' | '1h' | '8h' | 'until_resumed' | 'resume';
interface PrefsForm {
  categories: Record<string, { email: boolean; push: boolean }>;
  quiet: boolean;
  start: string;
  end: string;
  pause: Pause;
}
const toForm = (p: Preferences): PrefsForm => ({
  categories: Object.fromEntries(p.categories.map((c) => [c.category, { email: c.email, push: c.push }])),
  quiet: p.quietHours !== null,
  start: p.quietHours?.start ?? '22:00',
  end: p.quietHours?.end ?? '07:00',
  pause: '',
});

/** What an action waits on: it runs once the manager says how the person asked. */
type Pending = { title: string; description: ReactNode; confirm: string; danger?: boolean; run: (reasonCode: string) => Promise<unknown>; done: string } | null;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="stack stack--sm" style={{ padding: '16px 24px', borderTop: '1px solid var(--hairline-soft)' }}>
      <h3 className="t-title-md" style={{ fontSize: 15 }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

/**
 * The assisted path (ADR 0036): a manager acting for a resident or family
 * member who does not use the app. Every action asks how the person asked
 * (in person, by phone, in writing), is marked assisted, and tells the
 * account. An export is never shown here: it goes to the person's email.
 */
export function AssistPanel({ accountId, name }: { accountId: string; name: string }) {
  const toast = useToast();
  const path = { path: { id: accountId } };
  const part = (p: string) => keys.accountPart(accountId, p);
  const [pending, setPending] = useState<Pending>(null);

  const prefs = useQuery({
    queryKey: part('preferences'),
    queryFn: () => unwrap(api.GET('/api/v1/accounts/{id}/notification-preferences', { params: path })),
  });
  const consents = useQuery({
    queryKey: part('consents'),
    queryFn: () => unwrap(api.GET('/api/v1/accounts/{id}/consents', { params: path })),
  });
  const exports = useQuery({
    queryKey: part('data-exports'),
    queryFn: () => unwrap(api.GET('/api/v1/accounts/{id}/data-exports', { params: path })),
  });
  // No request at all is an answer here, not an error.
  const deletion = useQuery({
    queryKey: part('deletion-request'),
    queryFn: async () => {
      try {
        return await unwrap(api.GET('/api/v1/accounts/{id}/deletion-request', { params: path }));
      } catch (error) {
        if (error instanceof ApiError && error.code === 'DELETION_REQUEST_NOT_FOUND') return null;
        throw error;
      }
    },
  });

  const [form, setForm] = useState<PrefsForm | null>(null);
  useEffect(() => {
    if (prefs.data && form === null) setForm(toForm(prefs.data));
  }, [prefs.data, form]);

  const act = useAction((reasonCode: string) => pending!.run(reasonCode), {
    invalidate: [keys.account(accountId), keys.erasures],
    onDone: () => {
      toast.show(pending!.done);
      setPending(null);
    },
  });
  const ask = (p: NonNullable<Pending>) => {
    act.reset();
    setPending(p);
  };

  // --- preferences: only what changed is sent -------------------------------
  const saved = prefs.data;
  const changedCategories =
    saved && form
      ? saved.categories
          .filter((c) => form.categories[c.category]?.email !== c.email || form.categories[c.category]?.push !== c.push)
          .map((c) => ({ category: c.category, ...form.categories[c.category]! }))
      : [];
  const quietChanged =
    saved && form
      ? form.quiet !== (saved.quietHours !== null) ||
        (form.quiet && (form.start !== saved.quietHours?.start || form.end !== saved.quietHours?.end))
      : false;
  const prefsDirty = changedCategories.length > 0 || quietChanged || (form?.pause ?? '') !== '';
  const savePrefs = () =>
    ask({
      title: `Change ${name}'s notification settings?`,
      description: 'They are told their settings were changed for them. Security notices always reach them, whatever is set here.',
      confirm: 'Save settings',
      done: 'Notification settings saved.',
      run: async (reasonCode) => {
        const next = await unwrap(
          api.PATCH('/api/v1/accounts/{id}/notification-preferences', {
            params: path,
            body: {
              reasonCode,
              ...(changedCategories.length ? { categories: changedCategories } : {}),
              ...(quietChanged ? { quietHours: form!.quiet ? { start: form!.start, end: form!.end } : null } : {}),
              ...(form!.pause === 'resume' ? { pause: null } : form!.pause ? { pause: form!.pause } : {}),
            },
          }),
        );
        setForm(toForm(next));
        return next;
      },
    });

  const consentAction = (c: Consent) =>
    ask({
      title: c.granted ? `Withdraw this consent for ${name}?` : `Record ${name}'s consent?`,
      description: CONSENT_TEXT[c.code]?.body ?? humanize(c.code),
      confirm: c.granted ? 'Withdraw consent' : 'Record consent',
      done: c.granted ? 'Consent withdrawn.' : 'Consent recorded.',
      run: (reasonCode) =>
        c.granted
          ? unwrap(api.POST('/api/v1/accounts/{id}/consents/revoke', { params: path, body: { code: c.code, reasonCode } }))
          : unwrap(api.POST('/api/v1/accounts/{id}/consents/grant', { params: path, body: { code: c.code, version: c.version, reasonCode } })),
    });

  const d = deletion.data;
  const openDeletion = d && (d.status === 'pending' || d.status === 'queued') ? d : null;
  const blocked = act.error instanceof ApiError && act.error.code === 'DELETION_BLOCKED' ? act.error.params.blockers : undefined;

  return (
    <Card flush>
      <CardHeader title={`Act for ${name}`} />
      <CardBody>
        <p className="t-secondary">
          For someone who does not use the app and asked management to do this for them. Each action records how they asked and tells them
          what was done.
        </p>
      </CardBody>

      <Section title="Notification settings">
        <QueryState query={prefs} rows={3}>
          {form && saved ? (
            <div className="form">
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
                          setForm({
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
                label={`Quiet hours: hold non-urgent notices at night (their time zone, ${saved.timeZone})`}
                checked={form.quiet}
                onChange={(e) => setForm({ ...form, quiet: e.target.checked })}
              />
              {form.quiet ? (
                <div className="form__row">
                  <Field label="Quiet from">
                    {(p) => <Input {...p} type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />}
                  </Field>
                  <Field label="Quiet until" hint="Before the start: the window runs past midnight.">
                    {(p) => <Input {...p} type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />}
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
                  <Select {...p} value={form.pause} onChange={(e) => setForm({ ...form, pause: e.target.value as Pause })}>
                    <option value="">Leave as it is</option>
                    <option value="1h">Pause for 1 hour</option>
                    <option value="8h">Pause for 8 hours</option>
                    <option value="until_resumed">Pause until resumed</option>
                    {saved.pause ? <option value="resume">Resume now</option> : null}
                  </Select>
                )}
              </Field>
              <span className="row">
                <Button disabled={!prefsDirty} onClick={() => setForm(toForm(saved))}>
                  Discard
                </Button>
                <Button variant="primary" disabled={!prefsDirty} onClick={savePrefs}>
                  Save settings…
                </Button>
              </span>
            </div>
          ) : null}
        </QueryState>
      </Section>

      <Section title="Consents">
        <QueryState query={consents} rows={1}>
          {(consents.data?.data ?? []).map((c) => (
            <span key={c.code} className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <span className="list__text">
                <span className="list__title" style={{ display: 'block', whiteSpace: 'normal' }}>
                  {CONSENT_TEXT[c.code]?.title ?? humanize(c.code)}
                </span>
                <span className="list__meta">
                  {c.granted ? `Given ${formatDateTime(c.grantedAt)}` : 'Not given'} · {CONSENT_TEXT[c.code]?.body ?? ''}
                </span>
              </span>
              <Button size="sm" onClick={() => consentAction(c)}>
                {c.granted ? 'Withdraw…' : 'Record consent…'}
              </Button>
            </span>
          ))}
        </QueryState>
      </Section>

      <Section title="Copy of their data">
        <p className="t-secondary">
          The archive is sent to the person's own email, behind a code sent there too. Management never sees or downloads it.
        </p>
        <QueryState query={exports} rows={1}>
          {exports.data?.data.length ? (
            <ul className="list">
              {exports.data.data.map((e) => (
                <li key={e.id} className="list__item" style={{ paddingInline: 0 }}>
                  <span className="list__text">
                    <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <Badge tone={e.status === 'ready' ? 'green' : e.status === 'failed' ? 'error' : 'beige'}>{humanize(e.status)}</Badge>
                      <span>Asked {formatDateTime(e.requestedAt)}</span>
                      {e.assisted ? <Badge plain>By management</Badge> : <Badge plain>By the person</Badge>}
                    </span>
                    <span className="list__meta">
                      {e.readyAt ? `Ready ${formatDateTime(e.readyAt)}` : 'Not ready yet'}
                      {e.expiresAt ? ` · available until ${formatDateTime(e.expiresAt)}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="t-secondary">No export was ever asked for.</p>
          )}
        </QueryState>
        <span>
          <Button
            size="sm"
            onClick={() =>
              ask({
                title: `Send ${name} a copy of their data?`,
                description: 'It is prepared in the background and emailed to them. You will see its status here, never the file.',
                confirm: 'Request export',
                done: 'Export requested. It goes to their email when ready.',
                run: (reasonCode) => unwrap(api.POST('/api/v1/accounts/{id}/data-exports', { params: path, body: { reasonCode } })),
              })
            }
          >
            Request an export…
          </Button>
        </span>
      </Section>

      <Section title="Account deletion">
        <QueryState query={deletion} rows={1}>
          {d ? (
            <div className="stack stack--sm">
              <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <StatusBadge status={d.status} />
                <span>Asked {formatDateTime(d.requestedAt)}</span>
                {d.assisted ? <Badge plain>By management</Badge> : <Badge plain>By the person</Badge>}
              </span>
              <span className="t-secondary">
                {d.status === 'pending'
                  ? `Cooling-off until ${formatDateTime(d.effectiveAt)}: it can be cancelled until then, and the account works normally.`
                  : d.status === 'queued'
                    ? 'The cooling-off is over, but something blocks the erasure. It waits in Deletion requests.'
                    : d.status === 'completed'
                      ? 'The account was erased.'
                      : d.status === 'cancelled'
                        ? 'The last request was cancelled.'
                        : 'The last request was closed by management without erasing.'}
              </span>
              {d.blockers.length ? (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {d.blockers.map((b) => (
                    <li key={b}>{BLOCKER_TEXT[b] ?? humanize(b)}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <p className="t-secondary">No deletion was ever asked for.</p>
          )}
        </QueryState>
        <span>
          {openDeletion ? (
            <Button
              size="sm"
              onClick={() =>
                ask({
                  title: `Cancel ${name}'s deletion request?`,
                  description: 'For a request filed by mistake, or when they changed their mind. They are told it was cancelled.',
                  confirm: 'Cancel the request',
                  done: 'Deletion request cancelled.',
                  run: (reasonCode) =>
                    unwrap(api.POST('/api/v1/accounts/{id}/deletion-request/cancel', { params: path, body: { reasonCode } })),
                })
              }
            >
              Cancel the request…
            </Button>
          ) : (
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                ask({
                  title: `Ask to delete ${name}'s account?`,
                  description:
                    'A 14-day cooling-off starts, during which they or you can cancel. After it the account is erased for good: their personal data is blanked and they can no longer sign in.',
                  confirm: 'Request deletion',
                  danger: true,
                  done: 'Deletion requested. The cooling-off has started.',
                  run: (reasonCode) => unwrap(api.POST('/api/v1/accounts/{id}/deletion-request', { params: path, body: { reasonCode } })),
                })
              }
            >
              Request deletion…
            </Button>
          )}
        </span>
      </Section>

      <ReasonCodeDialog
        open={pending !== null}
        onClose={() => {
          setPending(null);
          act.reset();
        }}
        title={pending?.title ?? ''}
        description={pending?.description}
        codes={REASON_CODES.assist}
        codeLabel="How did they ask?"
        confirmLabel={pending?.confirm ?? 'Confirm'}
        danger={pending?.danger}
        pending={act.isPending}
        error={
          <div className="stack stack--sm">
            <ErrorAlert error={act.error} />
            {Array.isArray(blocked) ? (
              <Alert tone="warn">
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(blocked as string[]).map((b) => (
                    <li key={b}>{BLOCKER_TEXT[b] ?? humanize(b)}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
          </div>
        }
        onConfirm={(reasonCode) => act.mutate(reasonCode)}
      />
    </Card>
  );
}
