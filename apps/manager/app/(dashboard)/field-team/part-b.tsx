'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT, type Translate } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, DataTable, Field, Input, Select, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import ar from '@/messages/ar/ops-field-team';
import en from '@/messages/en/ops-field-team';

interface Ref {
  id: string;
  fullName?: string | null;
}
interface Suggestion {
  id: string;
  status: string;
  openTickets: number;
  available: number;
  threshold: number;
  createdAt: string;
}
interface Call {
  id: string;
  status: string;
  needed: number;
  accepted: number;
  recipientCount: number;
  startsAt: string;
  endsAt: string;
  zone: { nameEn: string; nameAr: string } | null;
  suggestionId: string | null;
}
interface Certificate {
  id: string;
  holder: Ref;
  kind: string;
  title: string;
  issuer: string | null;
  expiresOn: string;
  state: string;
  daysLeft: number;
  hasFile: boolean;
}
interface LastLocation {
  consent: boolean;
  last: {
    moment: string;
    ticketNumber: string | null;
    latitude: number;
    longitude: number;
    accuracyMeters: number | null;
    capturedAt: string;
  } | null;
}

const HOUR = 3_600_000;
const name = (t: Translate<typeof en>, r: Ref | null) => (r ? (r.fullName ?? t('erased')) : '—');
const list = <T,>(res: unknown) => (res as { data: T[] }).data;
const CERTIFICATE_KINDS = [
  'electrical',
  'plumbing',
  'gas',
  'hvac',
  'working_at_height',
  'first_aid',
  'fire_safety',
  'driving',
  'security_licence',
  'other',
] as const;

/**
 * Peak reinforcement (ADR 0090): service pressure's suggestions to answer
 * or dismiss, and the calls to the technicians off duty, each accepting
 * one writing a roster slot.
 */
export function ReinforcementTab() {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const toast = useToast();
  const suggestions = useQuery({
    queryKey: ['field-team', 'reinforcement', 'suggestions'],
    queryFn: async () =>
      list<Suggestion>(
        await unwrap(api.GET('/api/v1/staff/field-team/reinforcement-suggestions', { params: { query: { status: 'open' } } })),
      ),
  });
  const calls = useQuery({
    queryKey: ['field-team', 'reinforcement', 'calls'],
    queryFn: async () => list<Call>(await unwrap(api.GET('/api/v1/staff/field-team/reinforcement-calls', {}))),
  });
  const [form, setForm] = useState({ needed: '2', inHours: '1', hours: '4' });
  const open = suggestions.data?.[0];
  const send = useAction(
    () => {
      // A start at least a quarter of an hour ahead, as the call needs.
      const startsAt = new Date(Date.now() + Math.max(0.25, Number(form.inHours)) * HOUR);
      return unwrap(
        api.POST('/api/v1/staff/field-team/reinforcement-calls', {
          body: {
            needed: Number(form.needed),
            startsAt: startsAt.toISOString(),
            endsAt: new Date(startsAt.getTime() + Number(form.hours) * HOUR).toISOString(),
            ...(open ? { suggestionId: open.id } : {}),
          },
        }),
      );
    },
    { invalidate: [['field-team']], onDone: () => toast.show(t('callSent')) },
  );
  const dismiss = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/field-team/reinforcement-suggestions/{id}/dismiss', {
          params: { path: { id } },
          body: { reasonCode },
        }),
      ),
    { invalidate: [['field-team']], onDone: () => toast.show(t('dismissed')) },
  );
  const cancel = useAction(
    (id: string) =>
      unwrap(
        api.POST('/api/v1/staff/field-team/reinforcement-calls/{id}/cancel', {
          params: { path: { id } },
          body: { reasonCode: 'no_longer_needed' },
        }),
      ),
    { invalidate: [['field-team']], onDone: () => toast.show(t('calledOff')) },
  );
  return (
    <>
      <Card>
        <CardHeader title={t('callReinforcement')} />
        <CardBody>
          {open ? (
            <p>
              {t('suggested', {
                when: f.dateTime(open.createdAt),
                tickets: open.openTickets,
                available: open.available,
                threshold: open.threshold,
              })}
            </p>
          ) : null}
          <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <Field label={t('needed')}>
              {(p) => <Input {...p} type="number" min={1} max={10} value={form.needed} onChange={(e) => setForm({ ...form, needed: e.target.value })} />}
            </Field>
            <Field label={t('startsIn')}>
              {(p) => (
                <Input {...p} type="number" min={0.25} max={12} step={0.25} value={form.inHours} onChange={(e) => setForm({ ...form, inHours: e.target.value })} />
              )}
            </Field>
            <Field label={t('forHours')}>
              {(p) => <Input {...p} type="number" min={1} max={12} value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} />}
            </Field>
            <Button variant="primary" loading={send.isPending} onClick={() => send.mutate()}>
              {t('sendCall')}
            </Button>
            {open ? (
              <Select
                aria-label={t('dismissSuggestion')}
                value=""
                onChange={(e) => e.target.value && dismiss.mutate({ id: open.id, reasonCode: e.target.value })}
              >
                <option value="">{t('dismiss')}</option>
                {REASON_CODES.reinforcementDismiss.map((c) => (
                  <option key={c} value={c}>
                    {label(c)}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>
          <ErrorAlert error={send.error ?? dismiss.error} />
        </CardBody>
      </Card>
      <Card flush>
        <ErrorAlert error={cancel.error} />
        <QueryState query={calls}>
          <DataTable<Call>
            rows={calls.data ?? []}
            rowKey={(r) => r.id}
            empty={t('noCall')}
            columns={[
              { key: 's', header: t('col.starts'), cell: (r) => f.dateTime(r.startsAt) },
              { key: 'e', header: t('col.ends'), cell: (r) => f.dateTime(r.endsAt) },
              {
                key: 'z',
                header: t('col.zone'),
                cell: (r) => (r.zone ? (locale === 'ar' ? r.zone.nameAr : r.zone.nameEn) : t('wholeCompound')),
              },
              {
                key: 'a',
                header: t('col.accepted'),
                cell: (r) => t('accepted', { accepted: r.accepted, needed: r.needed, reached: r.recipientCount }),
              },
              { key: 'st', header: t('col.status'), cell: (r) => label(r.status) },
              {
                key: 'x',
                header: <span className="visually-hidden">{t('actions')}</span>,
                className: 'table__actions',
                cell: (r) =>
                  r.status === 'open' ? (
                    <Button size="sm" loading={cancel.isPending} onClick={() => cancel.mutate(r.id)}>
                      {t('callOff')}
                    </Button>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}

/**
 * Staff certificates (ADR 0090): each with the day it expires; warned of
 * 30 days ahead and on the day; an expired one blocks nothing.
 */
export function CertificatesTab({ technicians }: { technicians: Ref[] }) {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const certificates = useQuery({
    queryKey: ['field-team', 'certificates'],
    queryFn: async () => list<Certificate>(await unwrap(api.GET('/api/v1/staff/field-team/certificates', {}))),
  });
  const [form, setForm] = useState({ accountId: '', kind: 'electrical', title: '', issuer: '', expiresOn: '' });
  // The paper, uploaded first (purpose `staff_certificate`), filed with it.
  const [paper, setPaper] = useState<string | null>(null);
  const add = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/field-team/certificates', {
          body: {
            accountId: form.accountId,
            kind: form.kind as (typeof CERTIFICATE_KINDS)[number],
            title: form.title,
            ...(form.issuer ? { issuer: form.issuer } : {}),
            expiresOn: form.expiresOn,
            ...(paper ? { fileId: paper } : {}),
          },
        }),
      ),
    {
      invalidate: [['field-team']],
      onDone: () => {
        toast.show(t('certificateAdded'));
        setForm({ ...form, title: '', issuer: '', expiresOn: '' });
        setPaper(null);
      },
    },
  );
  const remove = useAction(
    (id: string) => unwrap(api.DELETE('/api/v1/staff/field-team/certificates/{id}', { params: { path: { id } } })),
    { invalidate: [['field-team']], onDone: () => toast.show(t('certificateRemoved')) },
  );
  // A filed certificate's paper: replaced (a new upload) or removed (null).
  const file = useAction(
    ({ id, fileId }: { id: string; fileId: string | null }) =>
      unwrap(api.PATCH('/api/v1/staff/field-team/certificates/{id}', { params: { path: { id } }, body: { fileId } })),
    { invalidate: [['field-team']], onDone: (_, v) => toast.show(v.fileId ? t('paperFiled') : t('paperRemoved')) },
  );
  // The list carries no links; the certificate's own read does, short-lived.
  const read = useAction(
    (id: string) => unwrap(api.GET('/api/v1/staff/field-team/certificates/{id}', { params: { path: { id } } })),
    { onDone: (r) => r.fileUrl && window.open(r.fileUrl, '_blank', 'noopener') },
  );
  return (
    <>
      <Card>
        <CardHeader title={t('addCertificate')} />
        <CardBody>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label={t('holder')}>
              {(p) => (
                <Select {...p} value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                  <option value="">{t('choose')}</option>
                  {technicians.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.fullName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('kind')}>
              {(p) => (
                <Select {...p} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  {CERTIFICATE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {label(k)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('certificateTitle')}>
              {(p) => <Input {...p} maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}
            </Field>
            <Field label={t('issuer')}>
              {(p) => <Input {...p} maxLength={120} value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} />}
            </Field>
            <Field label={t('expiresOn')}>
              {(p) => <Input {...p} type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />}
            </Field>
            <Button
              variant="primary"
              disabled={!form.accountId || !form.title || !form.expiresOn}
              loading={add.isPending}
              onClick={() => add.mutate()}
            >
              {t('add')}
            </Button>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            {paper ? (
              <>
                <span>{t('paperAttached')}</span>
                <Button size="sm" onClick={() => setPaper(null)}>
                  {t('detach')}
                </Button>
              </>
            ) : (
              <FileUpload purpose="staff_certificate" label={t('attachPaper')} onUploaded={setPaper} />
            )}
          </div>
          <ErrorAlert error={add.error} />
        </CardBody>
      </Card>
      <Card flush>
        <ErrorAlert error={remove.error ?? file.error ?? read.error} />
        <QueryState query={certificates}>
          <DataTable<Certificate>
            rows={certificates.data ?? []}
            rowKey={(r) => r.id}
            empty={t('noCertificate')}
            columns={[
              { key: 'h', header: t('col.holder'), cell: (r) => name(t, r.holder) },
              { key: 'k', header: t('kind'), cell: (r) => label(r.kind) },
              { key: 't', header: t('certificateTitle'), cell: (r) => r.title },
              { key: 'e', header: t('col.expires'), cell: (r) => f.day(r.expiresOn) },
              {
                key: 's',
                header: t('col.state'),
                cell: (r) => (r.state === 'expiring' ? t('expiring', { n: r.daysLeft }) : label(r.state)),
              },
              {
                key: 'f',
                header: t('col.paper'),
                cell: (r) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {r.hasFile ? (
                      <>
                        <Button size="sm" loading={read.isPending && read.variables === r.id} onClick={() => read.mutate(r.id)}>
                          {t('read')}
                        </Button>
                        <Button
                          size="sm"
                          loading={file.isPending && file.variables?.id === r.id && file.variables.fileId === null}
                          onClick={() => file.mutate({ id: r.id, fileId: null })}
                        >
                          {t('removePaper')}
                        </Button>
                      </>
                    ) : null}
                    <FileUpload
                      purpose="staff_certificate"
                      label={r.hasFile ? t('replace') : t('filePaper')}
                      disabled={file.isPending}
                      onUploaded={(fileId) => file.mutateAsync({ id: r.id, fileId }).then(() => undefined)}
                    />
                  </span>
                ),
              },
              {
                key: 'x',
                header: <span className="visually-hidden">{t('actions')}</span>,
                className: 'table__actions',
                cell: (r) => (
                  <Button size="sm" loading={remove.isPending} onClick={() => remove.mutate(r.id)}>
                    {t('remove')}
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}

/**
 * A technician's last known location (ADR 0090), one at a time, with
 * their consent; every read is audited.
 */
export function LocationTab({ technicians }: { technicians: Ref[] }) {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const [id, setId] = useState('');
  const location = useQuery({
    queryKey: ['field-team', 'location', id],
    queryFn: async () =>
      (await unwrap(
        api.GET('/api/v1/staff/field-team/technicians/{id}/location', { params: { path: { id } } }),
      )) as LastLocation,
    enabled: !!id,
  });
  const last = location.data?.last;
  return (
    <Card>
      <CardHeader title={t('lastLocation')} />
      <CardBody>
        <p>{t('locationNote')}</p>
        <Field label={t('technician')}>
          {(p) => (
            <Select {...p} value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">{t('choose')}</option>
              {technicians.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.fullName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {id ? (
          <QueryState query={location}>
            {last ? (
              <p>
                {t('locationOn', { moment: label(last.moment), ticket: last.ticketNumber ?? t('aTicket'), when: f.dateTime(last.capturedAt) })}{' '}
                <a href={`https://www.openstreetmap.org/?mlat=${last.latitude}&mlon=${last.longitude}#map=18/${last.latitude}/${last.longitude}`}>
                  <span className="ltr">
                    {last.latitude.toFixed(5)}, {last.longitude.toFixed(5)}
                  </span>
                </a>
                {last.accuracyMeters !== null ? ` ${t('accuracy', { m: last.accuracyMeters })}` : ''}
              </p>
            ) : (
              <p>{location.data?.consent ? t('noStep') : t('noConsent')}</p>
            )}
          </QueryState>
        ) : null}
      </CardBody>
    </Card>
  );
}
