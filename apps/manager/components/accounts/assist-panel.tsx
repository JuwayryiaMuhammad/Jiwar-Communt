'use client';

import { ApiError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Badge, Button, Card, CardBody, CardHeader, ReasonCodeDialog, StatusBadge, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { keys, type Consent } from '@/lib/queries';
import { preferencesChanges, PreferencesFields, toForm, type PrefsForm } from '@/components/notification-preferences';
import ar from '@/messages/ar/shell-accounts';
import en from '@/messages/en/shell-accounts';
import { blockerText, consentBody, consentTitle } from './labels';

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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
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
  const changes = saved && form ? preferencesChanges(saved, form) : null;
  const prefsDirty = changes !== null;
  const savePrefs = () =>
    ask({
      title: t('prefs.title', { name }),
      description: t('prefs.description'),
      confirm: t('prefs.confirm'),
      done: t('prefs.done'),
      run: async (reasonCode) => {
        const next = await unwrap(
          api.PATCH('/api/v1/accounts/{id}/notification-preferences', {
            params: path,
            body: { reasonCode, ...changes },
          }),
        );
        setForm(toForm(next));
        return next;
      },
    });

  const consentAction = (k: Consent) =>
    ask({
      title: k.granted ? t('consent.withdrawTitle', { name }) : t('consent.recordTitle', { name }),
      description: consentBody(t, k.code) ?? label(k.code),
      confirm: k.granted ? t('consent.withdrawConfirm') : t('consent.recordConfirm'),
      done: k.granted ? t('consent.withdrawn') : t('consent.recorded'),
      run: (reasonCode) =>
        k.granted
          ? unwrap(api.POST('/api/v1/accounts/{id}/consents/revoke', { params: path, body: { code: k.code, reasonCode } }))
          : unwrap(api.POST('/api/v1/accounts/{id}/consents/grant', { params: path, body: { code: k.code, version: k.version, reasonCode } })),
    });

  const d = deletion.data;
  const openDeletion = d && (d.status === 'pending' || d.status === 'queued') ? d : null;
  const blocked = act.error instanceof ApiError && act.error.code === 'DELETION_BLOCKED' ? act.error.params.blockers : undefined;

  return (
    <Card flush>
      <CardHeader title={t('assist.title', { name })} />
      <CardBody>
        <p className="t-secondary">{t('assist.intro')}</p>
      </CardBody>

      <Section title={t('assist.prefs')}>
        <QueryState query={prefs} rows={3}>
          {form && saved ? (
            <div className="form">
              <PreferencesFields saved={saved} form={form} onChange={setForm} />
              <span className="row">
                <Button disabled={!prefsDirty} onClick={() => setForm(toForm(saved))}>
                  {t('prefs.discard')}
                </Button>
                <Button variant="primary" disabled={!prefsDirty} onClick={savePrefs}>
                  {t('prefs.save')}
                </Button>
              </span>
            </div>
          ) : null}
        </QueryState>
      </Section>

      <Section title={t('assist.consents')}>
        <QueryState query={consents} rows={1}>
          {(consents.data?.data ?? []).map((k) => (
            <span key={k.code} className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <span className="list__text">
                <span className="list__title" style={{ display: 'block', whiteSpace: 'normal' }}>
                  {consentTitle(t, label, k.code)}
                </span>
                <span className="list__meta">
                  {k.granted ? t('consent.given', { when: f.dateTime(k.grantedAt) }) : t('consent.notGiven')} · {consentBody(t, k.code) ?? ''}
                </span>
              </span>
              <Button size="sm" onClick={() => consentAction(k)}>
                {k.granted ? t('consent.withdraw') : t('consent.record')}
              </Button>
            </span>
          ))}
        </QueryState>
      </Section>

      <Section title={t('assist.data')}>
        <p className="t-secondary">{t('data.intro')}</p>
        <QueryState query={exports} rows={1}>
          {exports.data?.data.length ? (
            <ul className="list">
              {exports.data.data.map((e) => (
                <li key={e.id} className="list__item" style={{ paddingInline: 0 }}>
                  <span className="list__text">
                    <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <Badge tone={e.status === 'ready' ? 'green' : e.status === 'failed' ? 'error' : 'beige'}>{label(e.status)}</Badge>
                      <span>{t('asked', { when: f.dateTime(e.requestedAt) })}</span>
                      {e.assisted ? <Badge plain>{t('byManagement')}</Badge> : <Badge plain>{t('byPerson')}</Badge>}
                    </span>
                    <span className="list__meta">
                      {e.readyAt ? t('data.ready', { when: f.dateTime(e.readyAt) }) : t('data.notReady')}
                      {e.expiresAt ? ` · ${t('data.availableUntil', { when: f.dateTime(e.expiresAt) })}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="t-secondary">{t('data.none')}</p>
          )}
        </QueryState>
        <span>
          <Button
            size="sm"
            onClick={() =>
              ask({
                title: t('data.title', { name }),
                description: t('data.description'),
                confirm: t('data.confirm'),
                done: t('data.done'),
                run: (reasonCode) => unwrap(api.POST('/api/v1/accounts/{id}/data-exports', { params: path, body: { reasonCode } })),
              })
            }
          >
            {t('data.request')}
          </Button>
        </span>
      </Section>

      <Section title={t('assist.deletion')}>
        <QueryState query={deletion} rows={1}>
          {d ? (
            <div className="stack stack--sm">
              <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <StatusBadge status={d.status} />
                <span>{t('asked', { when: f.dateTime(d.requestedAt) })}</span>
                {d.assisted ? <Badge plain>{t('byManagement')}</Badge> : <Badge plain>{t('byPerson')}</Badge>}
              </span>
              <span className="t-secondary">
                {d.status === 'pending'
                  ? t('deletion.pending', { when: f.dateTime(d.effectiveAt) })
                  : d.status === 'queued'
                    ? t('deletion.queued')
                    : d.status === 'completed'
                      ? t('deletion.completed')
                      : d.status === 'cancelled'
                        ? t('deletion.cancelled')
                        : t('deletion.closed')}
              </span>
              {d.blockers.length ? (
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                  {d.blockers.map((b) => (
                    <li key={b}>{blockerText(t, label, b)}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <p className="t-secondary">{t('deletion.none')}</p>
          )}
        </QueryState>
        <span>
          {openDeletion ? (
            <Button
              size="sm"
              onClick={() =>
                ask({
                  title: t('deletion.cancelTitle', { name }),
                  description: t('deletion.cancelDescription'),
                  confirm: t('deletion.cancelConfirm'),
                  done: t('deletion.cancelDone'),
                  run: (reasonCode) =>
                    unwrap(api.POST('/api/v1/accounts/{id}/deletion-request/cancel', { params: path, body: { reasonCode } })),
                })
              }
            >
              {t('deletion.cancel')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                ask({
                  title: t('deletion.requestTitle', { name }),
                  description: t('deletion.requestDescription'),
                  confirm: t('deletion.requestConfirm'),
                  danger: true,
                  done: t('deletion.requestDone'),
                  run: (reasonCode) => unwrap(api.POST('/api/v1/accounts/{id}/deletion-request', { params: path, body: { reasonCode } })),
                })
              }
            >
              {t('deletion.request')}
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
        codeLabel={t('assist.howAsked')}
        confirmLabel={pending?.confirm ?? c('confirm')}
        danger={pending?.danger}
        pending={act.isPending}
        error={
          <div className="stack stack--sm">
            <ErrorAlert error={act.error} />
            {Array.isArray(blocked) ? (
              <Alert tone="warn">
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                  {(blocked as string[]).map((b) => (
                    <li key={b}>{blockerText(t, label, b)}</li>
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
