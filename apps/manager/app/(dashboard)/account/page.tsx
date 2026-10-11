'use client';

import { formatDateTime, humanize, relativeTime, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, fieldError, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, DataTable, Field, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { preferencesChanges, PreferencesFields, toForm, type PrefsForm } from '@/components/notification-preferences';
import { api, bffAuth } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Session } from '@/lib/queries';
import { describeUserAgent } from '@/lib/user-agent';

type Locale = Schema<'Locale'>;
const LOCALE_TEXT: Record<Locale, string> = { en: 'English', ar: 'Arabic (العربية)' };

function Language({ current }: { current: Locale }) {
  const toast = useToast();
  const [locale, setLocale] = useState<Locale>(current);
  const save = useAction((next: Locale) => unwrap(api.PATCH('/api/v1/me/locale', { body: { locale: next } })), {
    invalidate: [keys.me],
    onDone: () => toast.show('Language saved.'),
  });
  return (
    <Card flush>
      <CardHeader title="Language" />
      <CardBody>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(locale);
          }}
        >
          <Field
            label="Language of what is sent to you"
            hint="Emails and notices from the compound. The dashboard itself is in English for now."
            error={fieldError(save.error, 'preferredLocale') ?? fieldError(save.error, 'locale')}
          >
            {(p) => (
              <Select {...p} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                {(Object.keys(LOCALE_TEXT) as Locale[]).map((l) => (
                  <option key={l} value={l}>
                    {LOCALE_TEXT[l]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ErrorAlert error={save.error} />
          <span className="row">
            <Button type="submit" variant="primary" disabled={locale === current} loading={save.isPending}>
              Save language
            </Button>
          </span>
        </form>
      </CardBody>
    </Card>
  );
}

function NotificationSettings() {
  const toast = useToast();
  const prefs = useQuery({ queryKey: keys.myPreferences, queryFn: fetchers.myPreferences });
  const [form, setForm] = useState<PrefsForm | null>(null);
  useEffect(() => {
    if (prefs.data && form === null) setForm(toForm(prefs.data));
  }, [prefs.data, form]);
  const saved = prefs.data;
  const changes = saved && form ? preferencesChanges(saved, form) : null;

  const save = useAction(
    (body: NonNullable<typeof changes>) => unwrap(api.PATCH('/api/v1/me/notification-preferences', { body })),
    {
      invalidate: [keys.myPreferences],
      onDone: (next) => {
        setForm(toForm(next));
        toast.show('Notification settings saved.');
      },
    },
  );

  return (
    <Card flush>
      <CardHeader title="Notification settings" />
      <CardBody>
        <QueryState query={prefs} rows={4}>
          {form && saved ? (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                if (changes) save.mutate(changes);
              }}
            >
              <p className="t-secondary">
                What is also sent to you by email. Everything stays in your notifications list whatever is set here, and emergencies and
                security notices always reach you.
              </p>
              <PreferencesFields saved={saved} form={form} onChange={setForm} own error={save.error} />
              <ErrorAlert error={save.error} />
              <span className="row">
                <Button disabled={changes === null || save.isPending} onClick={() => setForm(toForm(saved))}>
                  Discard
                </Button>
                <Button type="submit" variant="primary" disabled={changes === null} loading={save.isPending}>
                  Save settings
                </Button>
              </span>
            </form>
          ) : null}
        </QueryState>
      </CardBody>
    </Card>
  );
}

function Sessions() {
  const toast = useToast();
  const [ending, setEnding] = useState<Session | null>(null);
  const [endingAll, setEndingAll] = useState(false);
  const sessions = useQuery({ queryKey: keys.mySessions, queryFn: fetchers.mySessions });

  const revoke = useAction(
    (id: string) => unwrap(api.POST('/api/v1/me/sessions/{id}/revoke', { params: { path: { id } } })),
    {
      invalidate: [keys.mySessions],
      onDone: () => {
        toast.show('That session is signed out.');
        setEnding(null);
      },
    },
  );
  // Every session ends, this one included: the cookies go and the sign-in page opens.
  const revokeAll = useAction(async () => {
    await unwrap(api.POST('/api/v1/me/sessions/revoke-all'));
    await bffAuth('logout').catch(() => undefined);
    window.location.assign('/login');
  });

  const rows = sessions.data?.data;
  return (
    <Card flush>
      <CardHeader
        title="Where you are signed in"
        actions={
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              revokeAll.reset();
              setEndingAll(true);
            }}
          >
            Sign out everywhere
          </Button>
        }
      />
      <QueryState query={sessions} rows={2}>
        <DataTable<Session>
          rows={rows}
          rowKey={(s) => s.id}
          empty="No session"
          columns={[
            {
              key: 'device',
              header: 'Device',
              cell: (s) => (
                <span className="row" title={s.userAgent ?? undefined}>
                  {describeUserAgent(s.userAgent)}
                  {s.isCurrent ? <Badge tone="green">This session</Badge> : null}
                </span>
              ),
            },
            { key: 'since', header: 'Signed in', cell: (s) => formatDateTime(s.createdAt) },
            {
              key: 'used',
              header: 'Last used',
              cell: (s) => (s.lastUsedAt ? <span title={formatDateTime(s.lastUsedAt)}>{relativeTime(s.lastUsedAt)}</span> : '—'),
            },
            {
              key: 'actions',
              header: <span className="visually-hidden">Actions</span>,
              className: 'table__actions',
              cell: (s) =>
                s.isCurrent ? null : (
                  <Button
                    size="sm"
                    onClick={() => {
                      revoke.reset();
                      setEnding(s);
                    }}
                  >
                    Sign out
                  </Button>
                ),
            },
          ]}
        />
      </QueryState>
      <ConfirmDialog
        open={ending !== null}
        onClose={() => setEnding(null)}
        title="Sign this session out?"
        description={
          ending
            ? `${describeUserAgent(ending.userAgent)}, signed in ${formatDateTime(ending.createdAt)}. It has to sign in again with a code.`
            : undefined
        }
        confirmLabel="Sign out"
        pending={revoke.isPending}
        error={<ErrorAlert error={revoke.error} />}
        onConfirm={() => ending && revoke.mutate(ending.id)}
      />
      <ConfirmDialog
        open={endingAll}
        onClose={() => setEndingAll(false)}
        title="Sign out everywhere?"
        description="Every session of your account ends, this one included, on every device. Use it when a session here is not yours. You sign in again with a code."
        confirmLabel="Sign out everywhere"
        danger
        pending={revokeAll.isPending}
        error={<ErrorAlert error={revokeAll.error} />}
        onConfirm={() => revokeAll.mutate(undefined)}
      />
    </Card>
  );
}

/**
 * The signed-in account's own page: who they are, the language they are
 * written to in, what is delivered to them, and where they are signed in.
 * Their details are changed by whoever manages their account, not here.
 */
export default function AccountPage() {
  const { me, error } = usePermissions();
  return (
    <>
      <PageHeader title="My account" description="Your own sign-in, language and notification settings." />
      {me ? (
        <div className="stack">
          <Card flush>
            <CardHeader title={me.fullName ?? 'Your account'} />
            <CardBody>
              <dl className="dl">
                <dt>Role</dt>
                <dd>{me.role.name ?? humanize(me.role.key)}</dd>
                <dt>Email</dt>
                <dd>{me.email ?? '—'}</dd>
                <dt>Phone</dt>
                <dd className="t-num">{me.phone ?? '—'}</dd>
              </dl>
            </CardBody>
          </Card>
          <Language current={me.preferredLocale} />
          <NotificationSettings />
          <Sessions />
        </div>
      ) : (
        <QueryState query={{ isPending: !error, error }}>{null}</QueryState>
      )}
    </>
  );
}
