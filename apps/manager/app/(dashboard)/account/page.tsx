'use client';

import { unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, fieldError, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, DataTable, Field, PageHeader, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { preferencesChanges, PreferencesFields, toForm, type PrefsForm } from '@/components/notification-preferences';
import { api, bffAuth } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Session } from '@/lib/queries';
import { describeUserAgent } from '@/lib/user-agent';
import ar from '@/messages/ar/accounts-me';
import en from '@/messages/en/accounts-me';

type Locale = Schema<'Locale'>;
const LOCALES: readonly Locale[] = ['en', 'ar'];

function Language({ current }: { current: Locale }) {
  const t = useT(en, ar);
  const toast = useToast();
  const [locale, setLocale] = useState<Locale>(current);
  const save = useAction((next: Locale) => unwrap(api.PATCH('/api/v1/me/locale', { body: { locale: next } })), {
    invalidate: [keys.me],
    onDone: () => toast.show(t('language.saved')),
  });
  return (
    <Card flush>
      <CardHeader title={t('language.title')} />
      <CardBody>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(locale);
          }}
        >
          <Field
            label={t('language.label')}
            hint={t('language.hint')}
            error={fieldError(save.error, 'preferredLocale') ?? fieldError(save.error, 'locale')}
          >
            {(p) => (
              <Select {...p} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                {LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {t(`locale.${l}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ErrorAlert error={save.error} />
          <span className="row">
            <Button type="submit" variant="primary" disabled={locale === current} loading={save.isPending}>
              {t('language.save')}
            </Button>
          </span>
        </form>
      </CardBody>
    </Card>
  );
}

function NotificationSettings() {
  const t = useT(en, ar);
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
        toast.show(t('notify.saved'));
      },
    },
  );

  return (
    <Card flush>
      <CardHeader title={t('notify.title')} />
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
              <p className="t-secondary">{t('notify.intro')}</p>
              <PreferencesFields saved={saved} form={form} onChange={setForm} own error={save.error} />
              <ErrorAlert error={save.error} />
              <span className="row">
                <Button disabled={changes === null || save.isPending} onClick={() => setForm(toForm(saved))}>
                  {t('notify.discard')}
                </Button>
                <Button type="submit" variant="primary" disabled={changes === null} loading={save.isPending}>
                  {t('notify.save')}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const [ending, setEnding] = useState<Session | null>(null);
  const [endingAll, setEndingAll] = useState(false);
  const sessions = useQuery({ queryKey: keys.mySessions, queryFn: fetchers.mySessions });

  const revoke = useAction(
    (id: string) => unwrap(api.POST('/api/v1/me/sessions/{id}/revoke', { params: { path: { id } } })),
    {
      invalidate: [keys.mySessions],
      onDone: () => {
        toast.show(t('sessions.signedOut'));
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
        title={t('sessions.title')}
        actions={
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              revokeAll.reset();
              setEndingAll(true);
            }}
          >
            {t('sessions.signOutAll')}
          </Button>
        }
      />
      <QueryState query={sessions} rows={2}>
        <DataTable<Session>
          rows={rows}
          rowKey={(s) => s.id}
          empty={t('sessions.empty')}
          columns={[
            {
              key: 'device',
              header: t('sessions.device'),
              cell: (s) => (
                <span className="row" title={s.userAgent ?? undefined}>
                  {describeUserAgent(t, s.userAgent)}
                  {s.isCurrent ? <Badge tone="green">{t('sessions.current')}</Badge> : null}
                </span>
              ),
            },
            { key: 'since', header: t('sessions.signedIn'), cell: (s) => f.dateTime(s.createdAt) },
            {
              key: 'used',
              header: t('sessions.lastUsed'),
              cell: (s) => (s.lastUsedAt ? <span title={f.dateTime(s.lastUsedAt)}>{f.relative(s.lastUsedAt)}</span> : '—'),
            },
            {
              key: 'actions',
              header: <span className="visually-hidden">{c('actions')}</span>,
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
                    {t('sessions.signOut')}
                  </Button>
                ),
            },
          ]}
        />
      </QueryState>
      <ConfirmDialog
        open={ending !== null}
        onClose={() => setEnding(null)}
        title={t('sessions.endTitle')}
        description={
          ending ? t('sessions.endDescription', { device: describeUserAgent(t, ending.userAgent), when: f.dateTime(ending.createdAt) }) : undefined
        }
        confirmLabel={t('sessions.signOut')}
        pending={revoke.isPending}
        error={<ErrorAlert error={revoke.error} />}
        onConfirm={() => ending && revoke.mutate(ending.id)}
      />
      <ConfirmDialog
        open={endingAll}
        onClose={() => setEndingAll(false)}
        title={t('sessions.endAllTitle')}
        description={t('sessions.endAllDescription')}
        confirmLabel={t('sessions.signOutAll')}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const { me, error } = usePermissions();
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      {me ? (
        <div className="stack">
          <Card flush>
            <CardHeader title={me.fullName ?? t('yourAccount')} />
            <CardBody>
              <dl className="dl">
                <dt>{t('role')}</dt>
                <dd>{me.role.name ?? label(me.role.key)}</dd>
                <dt>{c('email')}</dt>
                <dd className="ltr">{me.email ?? '—'}</dd>
                <dt>{c('phone')}</dt>
                <dd className="t-num ltr">{me.phone ?? '—'}</dd>
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
