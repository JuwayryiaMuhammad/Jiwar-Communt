'use client';

import { fieldError, formatDate, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Select,
  Stat,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ContractDue, type ReadinessItem, type ReadinessProgram } from '@/lib/queries';

const ITEM_KINDS = ['task', 'estimate', 'contract_review', 'inspection_campaign'] as const;
const DECISIONS = REASON_CODES.contractReviewDecision;

/** Who may own an item: an active staff member or the manager. */
function useOwners() {
  const accounts = useQuery({ queryKey: [...keys.accounts, 'owners'], queryFn: () => fetchers.accounts(undefined, 100) });
  return (accounts.data?.data ?? []).filter((a) => !a.erased && a.status === 'active' && (a.type === 'staff' || a.type === 'manager'));
}

function NewItemDialog({ program, due, onClose }: { program: ReadinessProgram; due: ContractDue[]; onClose: () => void }) {
  const toast = useToast();
  const owners = useOwners();
  const checklists = useQuery({ queryKey: keys.checklists, queryFn: fetchers.checklists });
  const [f, setF] = useState({
    kind: 'task' as (typeof ITEM_KINDS)[number],
    title: '',
    ownerId: '',
    dueOn: program.startsOn,
    estimateAmount: '',
    contractId: '',
    checklistId: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/readiness/programs/{id}/items', {
          params: { path: { id: program.id } },
          body: {
            kind: f.kind,
            title: f.title.trim(),
            ownerId: f.ownerId,
            dueOn: f.dueOn,
            ...(f.estimateAmount && (f.kind === 'estimate' || f.kind === 'task') ? { estimateAmount: f.estimateAmount } : {}),
            ...(f.kind === 'contract_review' && f.contractId ? { contractId: f.contractId } : {}),
            ...(f.kind === 'inspection_campaign' && f.checklistId ? { checklistId: f.checklistId } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.readinessProgram(program.id), keys.readinessItems(program.id), keys.contractsDue(program.id)],
      onDone: () => {
        toast.show('Item added; its owner is told.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="New item"
      description={`Due by ${formatDate(program.endsOn)}, the program's last day.`}
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Add
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <div className="form__row">
          <Field label="Kind" error={fieldError(save.error, 'kind')}>
            {(p) => (
              <Select {...p} value={f.kind} onChange={set('kind')}>
                {ITEM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Due" error={fieldError(save.error, 'dueOn')}>
            {(p) => <Input {...p} type="date" value={f.dueOn} onChange={set('dueOn')} />}
          </Field>
        </div>
        <Field label="Title" error={fieldError(save.error, 'title')}>
          {(p) => <Input {...p} value={f.title} onChange={set('title')} />}
        </Field>
        <Field label="Owner" error={fieldError(save.error, 'ownerId')}>
          {(p) => (
            <Select {...p} value={f.ownerId} onChange={set('ownerId')}>
              <option value="">Choose…</option>
              {owners.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.fullName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {f.kind === 'estimate' || f.kind === 'task' ? (
          <Field
            label="Estimate (EGP)"
            hint={f.kind === 'task' ? 'Optional.' : undefined}
            error={fieldError(save.error, 'estimateAmount')}
          >
            {(p) => <Input {...p} inputMode="decimal" value={f.estimateAmount} onChange={set('estimateAmount')} />}
          </Field>
        ) : null}
        {f.kind === 'contract_review' ? (
          <Field label="Contract" error={fieldError(save.error, 'contractId')}>
            {(p) => (
              <Select {...p} value={f.contractId} onChange={set('contractId')}>
                <option value="">Choose…</option>
                {due
                  .filter((c) => c.itemId === null)
                  .map((c) => (
                    <option key={c.contractId} value={c.contractId}>
                      {c.code} · ends {formatDate(c.endsOn)}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        ) : null}
        {f.kind === 'inspection_campaign' ? (
          <Field label="Checklist" error={fieldError(save.error, 'checklistId')}>
            {(p) => (
              <Select {...p} value={f.checklistId} onChange={set('checklistId')}>
                <option value="">Choose…</option>
                {(checklists.data?.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
}

function CampaignDialog({ item, onClose }: { item: ReadinessItem; onClose: () => void }) {
  const toast = useToast();
  const technicians = useQuery({ queryKey: keys.technicians, queryFn: fetchers.technicians });
  const areas = useQuery({ queryKey: keys.areas({ active: 'true' }), queryFn: () => fetchers.areas({ active: 'true' }) });
  const campaign = useQuery({ queryKey: keys.campaign(item.id), queryFn: () => fetchers.campaign(item.id) });
  const [inspectorId, setInspectorId] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const held = new Set((campaign.data?.inspections ?? []).map((i) => i.commonAreaId));
  const spawn = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/readiness/items/{itemId}/campaign', {
          params: { path: { itemId: item.id } },
          body: { inspectorId, commonAreaIds: chosen },
        }),
      ),
    {
      invalidate: [keys.campaign(item.id), keys.readinessItems(item.programId)],
      onDone: (c) => {
        toast.show(`${c.spawned.length} inspection(s) scheduled.`);
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Inspection campaign"
      description={`One inspection per area, due ${formatDate(item.dueOn)}. The item is done when every one is submitted or cancelled.`}
      onSubmit={() => spawn.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button type="submit" variant="primary" loading={spawn.isPending} disabled={!chosen.length}>
            Schedule
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={spawn.error} />
        <Field label="Inspector" error={fieldError(spawn.error, 'inspectorId')}>
          {(p) => (
            <Select {...p} value={inspectorId} onChange={(e) => setInspectorId(e.target.value)}>
              <option value="">Choose…</option>
              {(technicians.data?.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.fullName ?? t.id}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <fieldset className="form__group">
          <legend>Areas</legend>
          {(areas.data?.data ?? []).map((a) => (
            <label key={a.id} className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                disabled={held.has(a.id)}
                checked={held.has(a.id) || chosen.includes(a.id)}
                onChange={(e) => setChosen(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))}
              />
              {a.code} · {a.nameEn}
              {held.has(a.id) ? ' (scheduled)' : ''}
            </label>
          ))}
        </fieldset>
        <p className="muted">
          {(campaign.data?.inspections ?? []).filter((i) => i.status === 'submitted' || i.status === 'cancelled').length} of{' '}
          {campaign.data?.inspections.length ?? 0} done.
        </p>
      </div>
    </Dialog>
  );
}

function CopyDialog({ program, onClose }: { program: ReadinessProgram; onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const [startsOn, setStartsOn] = useState(program.startsOn);
  const copy = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/readiness/programs/{id}/copy', {
          params: { path: { id: program.id } },
          body: { startsOn },
        }),
      ),
    {
      invalidate: [keys.readinessAll],
      onDone: (c) => {
        toast.show(
          c.reassignedItemIds.length
            ? `Copied; ${c.reassignedItemIds.length} item(s) are now yours, their owner may no longer own one.`
            : 'Copied.',
        );
        router.push(`/readiness/${c.id}`);
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Copy to a new start"
      description="Its end and every item's day move by as many days. Tasks, estimates and campaigns come open again; contract reviews are the copy's to add."
      onSubmit={() => copy.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={copy.isPending}>
            Copy
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={copy.error} />
        <Field label="New first day" error={fieldError(copy.error, 'startsOn')}>
          {(p) => <Input {...p} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** One readiness program (ADR 0067): its items, its readiness and the contracts it reviews. */
export default function ReadinessProgramPage() {
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const allowed = can('readiness.manage');
  const program = useQuery({ queryKey: keys.readinessProgram(id), queryFn: () => fetchers.readinessProgram(id), enabled: allowed });
  const items = useQuery({ queryKey: keys.readinessItems(id), queryFn: () => fetchers.readinessItems(id), enabled: allowed });
  const due = useQuery({ queryKey: keys.contractsDue(id), queryFn: () => fetchers.contractsDue(id), enabled: allowed });
  const [adding, setAdding] = useState(false);
  const [copying, setCopying] = useState(false);
  const [deciding, setDeciding] = useState<ReadinessItem | null>(null);
  const [cancelling, setCancelling] = useState<ReadinessItem | null>(null);
  const [campaign, setCampaign] = useState<ReadinessItem | null>(null);
  const refresh = [keys.readinessProgram(id), keys.readinessItems(id), keys.contractsDue(id)];
  const done = useAction(
    ({ itemId, decision }: { itemId: string; decision?: (typeof DECISIONS)[number] }) =>
      unwrap(
        api.POST('/api/v1/maintenance/readiness/items/{itemId}/done', {
          params: { path: { itemId } },
          body: decision ? { decision } : {},
        }),
      ),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show('Done.');
        setDeciding(null);
      },
    },
  );
  const cancel = useAction(
    ({ itemId, reasonCode }: { itemId: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/maintenance/readiness/items/{itemId}/cancel', {
          params: { path: { itemId } },
          body: { reasonCode },
        }),
      ),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show('Called off.');
        setCancelling(null);
      },
    },
  );
  const close = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/readiness/programs/{id}/close', { params: { path: { id } } })),
    { invalidate: [keys.readinessAll], onDone: () => toast.show('Closed.') },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Readiness" />
        <ForbiddenState />
      </>
    );
  const p = program.data;
  const open = p ? p.closedAt === null : false;
  return (
    <>
      <PageHeader
        title={p?.title ?? 'Program'}
        description={p ? `${humanize(p.kind)} · ${formatDate(p.startsOn)} – ${formatDate(p.endsOn)}${open ? '' : ' · closed'}` : undefined}
        actions={
          p ? (
            <span className="row" style={{ gap: 6 }}>
              <Button onClick={() => setCopying(true)}>Copy</Button>
              {open ? (
                <>
                  <Button loading={close.isPending} onClick={() => close.mutate()}>
                    Close
                  </Button>
                  <Button variant="primary" onClick={() => setAdding(true)}>
                    New item
                  </Button>
                </>
              ) : null}
            </span>
          ) : null
        }
      />
      <ErrorAlert error={close.error ?? done.error} />
      <QueryState query={program}>
        {p ? (
          <div className="row" style={{ gap: 12, marginBottom: 12 }}>
            <Stat label="Ready" value={p.readiness.percent === null ? '—' : `${p.readiness.percent}%`} />
            <Stat label="Done" value={p.readiness.done} />
            <Stat label="Open" value={p.readiness.open} />
            <Stat label="Called off" value={p.readiness.cancelled} />
            <Stat label="Budget (EGP)" value={p.readiness.budget} />
          </div>
        ) : null}
      </QueryState>
      <Card flush>
        <CardHeader title="Items" />
        <QueryState query={items}>
          <DataTable<ReadinessItem>
            rows={items.data?.data ?? []}
            rowKey={(i) => i.id}
            empty="No item"
            columns={[
              { key: 't', header: 'Item', cell: (i) => i.title },
              { key: 'k', header: 'Kind', cell: (i) => humanize(i.kind) },
              { key: 'd', header: 'Due', cell: (i) => formatDate(i.dueOn) },
              { key: 'e', header: 'Estimate (EGP)', cell: (i) => i.estimateAmount ?? '—' },
              {
                key: 's',
                header: 'State',
                cell: (i) => (i.decision ? `${humanize(i.state)} · ${humanize(i.decision)}` : humanize(i.state)),
              },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (i) =>
                  open && i.state === 'open' ? (
                    <span className="row" style={{ gap: 6 }}>
                      {i.kind === 'inspection_campaign' ? (
                        <Button size="sm" onClick={() => setCampaign(i)}>
                          Campaign
                        </Button>
                      ) : i.kind === 'contract_review' ? (
                        <Button size="sm" onClick={() => setDeciding(i)}>
                          Decide
                        </Button>
                      ) : (
                        <Button size="sm" loading={done.isPending} onClick={() => done.mutate({ itemId: i.id })}>
                          Done
                        </Button>
                      )}
                      <Button size="sm" onClick={() => setCancelling(i)}>
                        Call off
                      </Button>
                    </span>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      <Card flush>
        <CardHeader title="Contracts ending by the last day" />
        <QueryState query={due}>
          <DataTable<ContractDue>
            rows={due.data?.data ?? []}
            rowKey={(c) => c.contractId}
            empty="No contract ends in time"
            columns={[
              { key: 'c', header: 'Contract', cell: (c) => c.code },
              { key: 'k', header: 'Kind', cell: (c) => humanize(c.kind) },
              { key: 'e', header: 'Ends', cell: (c) => formatDate(c.endsOn) },
              { key: 'r', header: 'Review', cell: (c) => (c.itemId ? 'Planned' : 'Not yet') },
            ]}
          />
        </QueryState>
      </Card>
      {adding && p ? <NewItemDialog program={p} due={due.data?.data ?? []} onClose={() => setAdding(false)} /> : null}
      {copying && p ? <CopyDialog program={p} onClose={() => setCopying(false)} /> : null}
      {campaign ? <CampaignDialog item={campaign} onClose={() => setCampaign(null)} /> : null}
      <ReasonCodeDialog
        open={deciding !== null}
        onClose={() => setDeciding(null)}
        title="What was decided"
        codes={DECISIONS}
        confirmLabel="Record"
        pending={done.isPending}
        error={<ErrorAlert error={done.error} />}
        onConfirm={(c) => deciding && done.mutate({ itemId: deciding.id, decision: c as (typeof DECISIONS)[number] })}
      />
      <ReasonCodeDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Call the item off"
        codes={REASON_CODES.readinessItemCancel}
        confirmLabel="Call off"
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(c) => cancelling && cancel.mutate({ itemId: cancelling.id, reasonCode: c })}
      />
    </>
  );
}
