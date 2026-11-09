'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, DataTable, Field, Input, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';

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
  zone: { nameEn: string } | null;
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
const name = (r: Ref | null) => (r ? (r.fullName ?? 'Erased') : '—');
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
    { invalidate: [['field-team']], onDone: () => toast.show('Sent to every technician off duty.') },
  );
  const dismiss = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/field-team/reinforcement-suggestions/{id}/dismiss', {
          params: { path: { id } },
          body: { reasonCode },
        }),
      ),
    { invalidate: [['field-team']], onDone: () => toast.show('Dismissed.') },
  );
  const cancel = useAction(
    (id: string) =>
      unwrap(
        api.POST('/api/v1/staff/field-team/reinforcement-calls/{id}/cancel', {
          params: { path: { id } },
          body: { reasonCode: 'no_longer_needed' },
        }),
      ),
    { invalidate: [['field-team']], onDone: () => toast.show('Called off; the slots nobody filled are cancelled.') },
  );
  return (
    <>
      <Card>
        <CardHeader title="Call reinforcement" />
        <CardBody>
          {open ? (
            <p>
              Suggested {formatDateTime(open.createdAt)}: {open.openTickets} open tickets for {open.available} available
              technicians (the line is {open.threshold} each). Nothing reaches anyone off duty until you send a call.
            </p>
          ) : null}
          <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <Field label="Technicians needed">
              {(p) => <Input {...p} type="number" min={1} max={10} value={form.needed} onChange={(e) => setForm({ ...form, needed: e.target.value })} />}
            </Field>
            <Field label="Starts in (hours)">
              {(p) => (
                <Input {...p} type="number" min={0.25} max={12} step={0.25} value={form.inHours} onChange={(e) => setForm({ ...form, inHours: e.target.value })} />
              )}
            </Field>
            <Field label="For (hours)">
              {(p) => <Input {...p} type="number" min={1} max={12} value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} />}
            </Field>
            <Button variant="primary" loading={send.isPending} onClick={() => send.mutate()}>
              Send the call
            </Button>
            {open ? (
              <Select
                aria-label="Dismiss the suggestion"
                value=""
                onChange={(e) => e.target.value && dismiss.mutate({ id: open.id, reasonCode: e.target.value })}
              >
                <option value="">Dismiss…</option>
                {REASON_CODES.reinforcementDismiss.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
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
            empty="No reinforcement call yet"
            columns={[
              { key: 's', header: 'Starts', cell: (r) => formatDateTime(r.startsAt) },
              { key: 'e', header: 'Ends', cell: (r) => formatDateTime(r.endsAt) },
              { key: 'z', header: 'Zone', cell: (r) => r.zone?.nameEn ?? 'Whole compound' },
              { key: 'a', header: 'Accepted', cell: (r) => `${r.accepted} of ${r.needed} (${r.recipientCount} reached)` },
              { key: 'st', header: 'Status', cell: (r) => humanize(r.status) },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (r) =>
                  r.status === 'open' ? (
                    <Button size="sm" loading={cancel.isPending} onClick={() => cancel.mutate(r.id)}>
                      Call off
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
        toast.show('Added.');
        setForm({ ...form, title: '', issuer: '', expiresOn: '' });
        setPaper(null);
      },
    },
  );
  const remove = useAction(
    (id: string) => unwrap(api.DELETE('/api/v1/staff/field-team/certificates/{id}', { params: { path: { id } } })),
    { invalidate: [['field-team']], onDone: () => toast.show('Removed.') },
  );
  // A filed certificate's paper: replaced (a new upload) or removed (null).
  const file = useAction(
    ({ id, fileId }: { id: string; fileId: string | null }) =>
      unwrap(api.PATCH('/api/v1/staff/field-team/certificates/{id}', { params: { path: { id } }, body: { fileId } })),
    { invalidate: [['field-team']], onDone: (_, v) => toast.show(v.fileId ? 'Paper filed.' : 'Paper removed.') },
  );
  // The list carries no links; the certificate's own read does, short-lived.
  const read = useAction(
    (id: string) => unwrap(api.GET('/api/v1/staff/field-team/certificates/{id}', { params: { path: { id } } })),
    { onDone: (r) => r.fileUrl && window.open(r.fileUrl, '_blank', 'noopener') },
  );
  return (
    <>
      <Card>
        <CardHeader title="Add a certificate" />
        <CardBody>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Holder">
              {(p) => (
                <Select {...p} value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                  <option value="">Choose</option>
                  {technicians.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.fullName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Kind">
              {(p) => (
                <Select {...p} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  {CERTIFICATE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {humanize(k)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Title">
              {(p) => <Input {...p} maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}
            </Field>
            <Field label="Issuer">
              {(p) => <Input {...p} maxLength={120} value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} />}
            </Field>
            <Field label="Expires on">
              {(p) => <Input {...p} type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />}
            </Field>
            <Button
              variant="primary"
              disabled={!form.accountId || !form.title || !form.expiresOn}
              loading={add.isPending}
              onClick={() => add.mutate()}
            >
              Add
            </Button>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            {paper ? (
              <>
                <span>The paper is attached.</span>
                <Button size="sm" onClick={() => setPaper(null)}>
                  Detach
                </Button>
              </>
            ) : (
              <FileUpload purpose="staff_certificate" label="Attach the paper (optional)" onUploaded={setPaper} />
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
            empty="No certificate yet"
            columns={[
              { key: 'h', header: 'Holder', cell: (r) => name(r.holder) },
              { key: 'k', header: 'Kind', cell: (r) => humanize(r.kind) },
              { key: 't', header: 'Title', cell: (r) => r.title },
              { key: 'e', header: 'Expires', cell: (r) => r.expiresOn },
              {
                key: 's',
                header: 'State',
                cell: (r) => (r.state === 'expiring' ? `Expiring (${r.daysLeft} d)` : humanize(r.state)),
              },
              {
                key: 'f',
                header: 'Paper',
                cell: (r) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {r.hasFile ? (
                      <>
                        <Button size="sm" loading={read.isPending && read.variables === r.id} onClick={() => read.mutate(r.id)}>
                          Read
                        </Button>
                        <Button
                          size="sm"
                          loading={file.isPending && file.variables?.id === r.id && file.variables.fileId === null}
                          onClick={() => file.mutate({ id: r.id, fileId: null })}
                        >
                          Remove the paper
                        </Button>
                      </>
                    ) : null}
                    <FileUpload
                      purpose="staff_certificate"
                      label={r.hasFile ? 'Replace' : 'File the paper'}
                      disabled={file.isPending}
                      onUploaded={(fileId) => file.mutateAsync({ id: r.id, fileId }).then(() => undefined)}
                    />
                  </span>
                ),
              },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (r) => (
                  <Button size="sm" loading={remove.isPending} onClick={() => remove.mutate(r.id)}>
                    Remove
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
      <CardHeader title="Last known location" />
      <CardBody>
        <p>
          Taken only with the technician’s consent, on the way, at the door and starting the work; kept 30 days. Each read is
          recorded.
        </p>
        <Field label="Technician">
          {(p) => (
            <Select {...p} value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">Choose</option>
              {technicians.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.fullName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {id ? (
          <QueryState query={location}>
            {last ? (
              <p>
                {humanize(last.moment)} on {last.ticketNumber ?? 'a ticket'}, {formatDateTime(last.capturedAt)}:{' '}
                <a href={`https://www.openstreetmap.org/?mlat=${last.latitude}&mlon=${last.longitude}#map=18/${last.latitude}/${last.longitude}`}>
                  {last.latitude.toFixed(5)}, {last.longitude.toFixed(5)}
                </a>
                {last.accuracyMeters !== null ? ` (±${last.accuracyMeters} m)` : ''}
              </p>
            ) : (
              <p>{location.data?.consent ? 'No step with a location in the 30 days.' : 'The technician has not consented.'}</p>
            )}
          </QueryState>
        ) : null}
      </CardBody>
    </Card>
  );
}
