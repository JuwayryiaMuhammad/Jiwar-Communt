'use client';

import { fieldError, formatDate, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Textarea,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ComplianceItemDetail } from '@/lib/queries';

type Occurrence = ComplianceItemDetail['occurrences'][number];

/** A due day done (ADR 0087): the day, what it gave, and the next due day. */
function CompleteDialog({ item, onClose }: { item: ComplianceItemDetail; onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ doneOn: '', certificateNumber: '', expiresOn: '', nextDueOn: '', note: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/compliance/occurrences/{occurrenceId}/complete', {
          params: { path: { occurrenceId: item.current!.id } },
          body: {
            doneOn: f.doneOn,
            ...(f.certificateNumber.trim() ? { certificateNumber: f.certificateNumber.trim() } : {}),
            ...(f.expiresOn ? { expiresOn: f.expiresOn } : {}),
            ...(f.nextDueOn ? { nextDueOn: f.nextDueOn } : {}),
            ...(f.note.trim() ? { note: f.note.trim() } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.complianceAll],
      onDone: (d) => {
        toast.show(d.current ? `Recorded; next due ${formatDate(d.current.dueOn)}.` : 'Recorded; nothing more is due.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Record it done"
      onSubmit={() => f.doneOn && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!f.doneOn}>
            Record
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <div className="form__row">
          <Field label="Done on" error={fieldError(save.error, 'doneOn')}>
            {(p) => <Input {...p} type="date" value={f.doneOn} onChange={set('doneOn')} />}
          </Field>
          <Field label="Expires on" hint="Of what it gave: the next due day by default." error={fieldError(save.error, 'expiresOn')}>
            {(p) => <Input {...p} type="date" value={f.expiresOn} onChange={set('expiresOn')} />}
          </Field>
        </div>
        <div className="form__row">
          <Field label="Certificate number" error={fieldError(save.error, 'certificateNumber')}>
            {(p) => <Input {...p} value={f.certificateNumber} onChange={set('certificateNumber')} />}
          </Field>
          <Field label="Next due" hint="Optional: overrides the expiry and the recurrence." error={fieldError(save.error, 'nextDueOn')}>
            {(p) => <Input {...p} type="date" value={f.nextDueOn} onChange={set('nextDueOn')} />}
          </Field>
        </div>
        <Field label="Note" hint="About the work." error={fieldError(save.error, 'note')}>
          {(p) => <Textarea {...p} rows={2} maxLength={1000} value={f.note} onChange={set('note')} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** A compliance item (ADR 0087): where it stands, its archive, and its completion. */
export default function ComplianceItemPage() {
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const allowed = can('compliance.manage');
  const item = useQuery({ queryKey: keys.complianceItem(id), queryFn: () => fetchers.complianceItem(id), enabled: allowed });
  const [completing, setCompleting] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const retire = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/compliance/items/{id}/retire', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.complianceAll],
      onDone: () => {
        toast.show('The item is retired.');
        setRetiring(false);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Compliance item" />
        <ForbiddenState />
      </>
    );
  const i = item.data;
  return (
    <QueryState query={item}>
      {i ? (
        <>
          <PageHeader
            title={i.title}
            description={`${humanize(i.kind)} · ${humanize(i.state)}${i.current ? ` · due ${formatDate(i.current.dueOn)}` : ''}`}
            actions={
              i.retiredAt ? null : (
                <>
                  {i.current ? (
                    <Button variant="primary" onClick={() => setCompleting(true)}>
                      Record done
                    </Button>
                  ) : null}
                  <Button onClick={() => setRetiring(true)}>Retire</Button>
                </>
              )
            }
          />
          <Card flush>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="dl">
                <dt>Authority</dt>
                <dd>{i.authority ?? '—'}</dd>
                <dt>Reference</dt>
                <dd>{i.reference ?? '—'}</dd>
                <dt>About</dt>
                <dd>{i.asset ? `Asset ${i.asset.code}` : i.commonArea ? `${i.commonArea.nameEn} (${i.commonArea.code})` : 'The compound'}</dd>
                <dt>Answers for it</dt>
                <dd>{[i.vendor?.name, i.owner?.fullName].filter(Boolean).join(' · ') || '—'}</dd>
                <dt>Recurs</dt>
                <dd>{i.recurrenceMonths ? `Every ${i.recurrenceMonths} months` : 'Once'}</dd>
                <dt>Told ahead</dt>
                <dd>
                  {i.leadDays.map((d) => `${d} days`).join(', ')}
                  {i.ownLeadDays ? '' : ' (the compound’s)'}
                </dd>
              </dl>
            </CardBody>
          </Card>
          <Card flush>
            <CardHeader title="Due days and evidence" />
            <DataTable<Occurrence>
              rows={i.occurrences}
              rowKey={(o) => o.id}
              empty="No due day"
              columns={[
                { key: 'd', header: 'Due', cell: (o) => formatDate(o.dueOn) },
                { key: 's', header: 'Status', cell: (o) => humanize(o.status) },
                { key: 'done', header: 'Done', cell: (o) => (o.doneOn ? formatDate(o.doneOn) : '—') },
                { key: 'c', header: 'Certificate', cell: (o) => o.certificateNumber ?? '—' },
                { key: 'e', header: 'Expires', cell: (o) => (o.expiresOn ? formatDate(o.expiresOn) : '—') },
                {
                  key: 'f',
                  header: 'Evidence',
                  cell: (o) =>
                    o.evidence.length
                      ? o.evidence.map((e, n) =>
                          e.fileUrl ? (
                            <a key={e.id} className="table__link" href={e.fileUrl} target="_blank" rel="noreferrer">
                              File {n + 1}{' '}
                            </a>
                          ) : null,
                        )
                      : '—',
                },
              ]}
            />
          </Card>
          {completing ? <CompleteDialog item={i} onClose={() => setCompleting(false)} /> : null}
          <ReasonCodeDialog
            open={retiring}
            onClose={() => setRetiring(false)}
            title="Retire the item"
            description="Final: its open due day is called off."
            codes={REASON_CODES.complianceRetire}
            confirmLabel="Retire"
            danger
            pending={retire.isPending}
            error={<ErrorAlert error={retire.error} />}
            onConfirm={(c) => retire.mutate(c)}
          />
        </>
      ) : null}
    </QueryState>
  );
}
