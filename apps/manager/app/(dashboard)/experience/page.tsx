'use client';

import { REASON_CODES, formatDateTime, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, ButtonLink, Card, DataTable, Dialog, Field, ForbiddenState, PageHeader, Select, Textarea, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ExperienceCase, type ExperienceSignal } from '@/lib/queries';

type Status = 'open' | 'closed' | '';
type Kind = 'follow_up' | 'recovery' | '';

/**
 * Experience and recovery (ADR 0082): the follow-up and recovery cases, one
 * open per unit, and the signals the rules raised (no AI: ratings of 1 or 2,
 * tickets sent back, complaints the unit made, within the compound's
 * thresholds). A case is worked on its own page.
 */
export default function ExperiencePage() {
  const { ready, can } = usePermissions();
  const allowed = can('experience.manage');
  const toast = useToast();
  const [status, setStatus] = useState<Status>('open');
  const [kind, setKind] = useState<Kind>('');
  const [opening, setOpening] = useState(false);
  const [unitId, setUnitId] = useState('');
  const [newKind, setNewKind] = useState<'follow_up' | 'recovery'>('recovery');
  const [failureCode, setFailureCode] = useState('');
  const [note, setNote] = useState('');
  const cases = useCursorList(keys.experienceCases({ status, kind }), (c) => fetchers.experienceCases({ status, kind }, c), {
    enabled: allowed,
  });
  const signals = useCursorList(keys.experienceSignals({}), (c) => fetchers.experienceSignals({}, c), { enabled: allowed });
  const open = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/experience/cases', {
          body: { unitId, kind: newKind, ...(failureCode ? { failureCode } : {}), ...(note.trim() ? { note } : {}) },
        }),
      ),
    {
      invalidate: [keys.experienceAll],
      onDone: (c) => {
        toast.show(`${c.number} is open.`);
        setOpening(false);
        setUnitId('');
        setNote('');
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Resident experience" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Resident experience"
        description="Follow-up and recovery cases, one open per unit, and the signals the rules raised. Due times are the inbox’s for each kind."
        actions={
          <span className="row" style={{ gap: 6 }}>
            <ButtonLink href="/experience/reports">Reports</ButtonLink>
            <ButtonLink href="/experience/setup">Setup</ButtonLink>
            <Button variant="primary" onClick={() => setOpening(true)}>
              Open a case
            </Button>
          </span>
        }
      />
      <div className="toolbar">
        <Field label="Status">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
              <option value="">Any status</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </Select>
          )}
        </Field>
        <Field label="Kind">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="">Any kind</option>
              <option value="follow_up">Follow-up</option>
              <option value="recovery">Recovery</option>
            </Select>
          )}
        </Field>
      </div>
      <Card flush>
        <QueryState query={cases}>
          <DataTable<ExperienceCase>
            rows={cases.rows}
            rowKey={(c) => c.id}
            empty="No case matches"
            columns={[
              {
                key: 'number',
                header: 'Case',
                cell: (c) => (
                  <Link className="table__link" href={`/experience/cases/${c.id}`}>
                    {c.number}
                  </Link>
                ),
              },
              { key: 'unit', header: 'Unit', cell: (c) => `${c.unitCode ?? '—'}${c.building ? ` · ${c.building}` : ''}` },
              { key: 'kind', header: 'Kind', cell: (c) => humanize(c.kind) },
              { key: 'origin', header: 'Opened by', cell: (c) => (c.origin === 'signal' ? 'A signal' : 'The staff') },
              { key: 'due', header: 'Due', width: 170, cell: (c) => (c.dueAt ? formatDateTime(c.dueAt) : '—') },
              { key: 'status', header: 'Status', cell: (c) => <Badge>{humanize(c.outcome ?? c.status)}</Badge> },
            ]}
          />
          <LoadMore query={cases} />
        </QueryState>
      </Card>
      <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
        Signals
      </h2>
      <Card flush>
        <QueryState query={signals}>
          <DataTable<ExperienceSignal>
            rows={signals.rows}
            rowKey={(s) => s.id}
            empty="No signal yet"
            columns={[
              { key: 'at', header: 'Detected', width: 170, cell: (s) => formatDateTime(s.detectedAt) },
              { key: 'unit', header: 'Unit', cell: (s) => s.unitCode ?? '—' },
              { key: 'rule', header: 'Rule', cell: (s) => humanize(s.code) },
              { key: 'count', header: 'Events', cell: (s) => `${s.count} in ${s.windowDays} days` },
              {
                key: 'case',
                header: 'Case',
                cell: (s) =>
                  s.caseId ? (
                    <Link className="table__link" href={`/experience/cases/${s.caseId}`}>
                      Open case
                    </Link>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
          <LoadMore query={signals} />
        </QueryState>
      </Card>
      <Dialog
        open={opening}
        onClose={() => setOpening(false)}
        title="Open a case"
        description="One open case per unit: a unit with one is refused and its case named."
        onSubmit={(e) => {
          e.preventDefault();
          open.mutate();
        }}
        footer={
          <Button type="submit" variant="primary" loading={open.isPending} disabled={!unitId}>
            Open
          </Button>
        }
      >
        <div className="stack">
          <Field label="Unit">{(p) => <UnitPicker {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}</Field>
          <Field label="Kind">
            {(p) => (
              <Select {...p} value={newKind} onChange={(e) => setNewKind(e.target.value as 'follow_up' | 'recovery')}>
                <option value="recovery">Recovery (a service failed)</option>
                <option value="follow_up">Follow-up (before they complain)</option>
              </Select>
            )}
          </Field>
          <Field label="What failed">
            {(p) => (
              <Select {...p} value={failureCode} onChange={(e) => setFailureCode(e.target.value)}>
                <option value="">Not said</option>
                {REASON_CODES.creditNoteCompensation.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Note" hint="For the staff only; never in the audit trail.">
            {(p) => <Textarea {...p} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <ErrorAlert error={open.error} />
        </div>
      </Dialog>
    </>
  );
}
