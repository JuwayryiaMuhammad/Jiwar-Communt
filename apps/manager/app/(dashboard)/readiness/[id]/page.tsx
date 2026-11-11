'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AccountPicker } from '@/components/pickers';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ContractDue, type ReadinessItem, type ReadinessProgram } from '@/lib/queries';
import ar from '@/messages/ar/ops-readiness';
import en from '@/messages/en/ops-readiness';

const ITEM_KINDS = ['task', 'estimate', 'contract_review', 'inspection_campaign', 'drill'] as const;
/** What a drill rehearses (ADR 0087). */
const DRILL_TYPES = ['fire', 'evacuation', 'lockdown', 'medical', 'earthquake', 'other'] as const;
const OUTCOMES = REASON_CODES.drillOutcome;
const DECISIONS = REASON_CODES.contractReviewDecision;

function NewItemDialog({ program, due, onClose }: { program: ReadinessProgram; due: ContractDue[]; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const toast = useToast();
  const checklists = useQuery({ queryKey: keys.checklists, queryFn: fetchers.checklists });
  const [f, setF] = useState({
    kind: 'task' as (typeof ITEM_KINDS)[number],
    title: '',
    ownerId: '',
    dueOn: program.startsOn,
    estimateAmount: '',
    contractId: '',
    checklistId: '',
    drillType: 'fire' as (typeof DRILL_TYPES)[number],
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
            ...(f.kind === 'drill' ? { drillType: f.drillType } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.readinessProgram(program.id), keys.readinessItems(program.id), keys.contractsDue(program.id)],
      onDone: () => {
        toast.show(t('itemAdded'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('newItem')}
      description={t('newItemDescription', { day: fmt.day(program.endsOn) })}
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {t('add')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <div className="form__row">
          <Field label={t('kind')} error={fieldError(save.error, 'kind')}>
            {(p) => (
              <Select {...p} value={f.kind} onChange={set('kind')}>
                {ITEM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('due')} error={fieldError(save.error, 'dueOn')}>
            {(p) => <Input {...p} type="date" value={f.dueOn} onChange={set('dueOn')} />}
          </Field>
        </div>
        <Field label={t('itemTitle')} error={fieldError(save.error, 'title')}>
          {(p) => <Input {...p} value={f.title} onChange={set('title')} />}
        </Field>
        <Field label={t('owner')} error={fieldError(save.error, 'ownerId')}>
          {(p) => (
            <AccountPicker {...p} group="staff" placeholder={t('choose')} value={f.ownerId} onChange={(id) => setF({ ...f, ownerId: id })} />
          )}
        </Field>
        {f.kind === 'estimate' || f.kind === 'task' ? (
          <Field
            label={t('estimate')}
            hint={f.kind === 'task' ? t('optional') : undefined}
            error={fieldError(save.error, 'estimateAmount')}
          >
            {(p) => <Input {...p} inputMode="decimal" value={f.estimateAmount} onChange={set('estimateAmount')} />}
          </Field>
        ) : null}
        {f.kind === 'contract_review' ? (
          <Field label={t('contract')} error={fieldError(save.error, 'contractId')}>
            {(p) => (
              <Select {...p} value={f.contractId} onChange={set('contractId')}>
                <option value="">{t('choose')}</option>
                {due
                  .filter((x) => x.itemId === null)
                  .map((x) => (
                    <option key={x.contractId} value={x.contractId}>
                      {t('contractOption', { code: x.code, day: fmt.day(x.endsOn) })}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        ) : null}
        {f.kind === 'drill' ? (
          <Field label={t('drill')} error={fieldError(save.error, 'drillType')}>
            {(p) => (
              <Select {...p} value={f.drillType} onChange={set('drillType')}>
                {DRILL_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {label(d)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        {f.kind === 'inspection_campaign' ? (
          <Field label={t('checklist')} error={fieldError(save.error, 'checklistId')}>
            {(p) => (
              <Select {...p} value={f.checklistId} onChange={set('checklistId')}>
                <option value="">{t('choose')}</option>
                {(checklists.data?.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {fmt.locale === 'ar' ? x.nameAr : x.nameEn}
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

/** A drill done (ADR 0087): its outcome, how many took part, and its minutes when counted. */
function DrillDoneDialog({ item, refresh, onClose }: { item: ReadinessItem; refresh: QueryKey[]; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [f, setF] = useState({ outcome: OUTCOMES[0] as (typeof OUTCOMES)[number], participants: '', minutes: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/readiness/items/{itemId}/done', {
          params: { path: { itemId: item.id } },
          body: {
            outcome: f.outcome,
            participants: Number(f.participants),
            ...(f.minutes ? { minutes: Number(f.minutes) } : {}),
          },
        }),
      ),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show(t('drillRecorded'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('drillTitle', { title: item.title })}
      onSubmit={() => f.participants !== '' && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={f.participants === ''}>
            {t('record')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <Field label={t('outcome')} error={fieldError(save.error, 'outcome')}>
          {(p) => (
            <Select {...p} value={f.outcome} onChange={set('outcome')}>
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {label(o)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="form__row">
          <Field label={t('tookPart')} error={fieldError(save.error, 'participants')}>
            {(p) => <Input {...p} inputMode="numeric" value={f.participants} onChange={set('participants')} />}
          </Field>
          <Field label={t('minutes')} hint={t('minutesHint')} error={fieldError(save.error, 'minutes')}>
            {(p) => <Input {...p} inputMode="numeric" value={f.minutes} onChange={set('minutes')} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function CampaignDialog({ item, onClose }: { item: ReadinessItem; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const { locale } = useLocale();
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
      onDone: (x) => {
        toast.show(t('scheduledToast', { n: x.spawned.length }));
        onClose();
      },
    },
  );
  const inspections = campaign.data?.inspections ?? [];
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('campaignTitle')}
      description={t('campaignDescription', { day: fmt.day(item.dueOn) })}
      onSubmit={() => spawn.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('close')}</Button>
          <Button type="submit" variant="primary" loading={spawn.isPending} disabled={!chosen.length}>
            {t('schedule')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={spawn.error} />
        <Field label={t('inspector')} error={fieldError(spawn.error, 'inspectorId')}>
          {(p) => (
            <Select {...p} value={inspectorId} onChange={(e) => setInspectorId(e.target.value)}>
              <option value="">{t('choose')}</option>
              {(technicians.data?.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.fullName ?? x.id}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <fieldset className="form__group">
          <legend>{t('areas')}</legend>
          {(areas.data?.data ?? []).map((a) => (
            <label key={a.id} className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                disabled={held.has(a.id)}
                checked={held.has(a.id) || chosen.includes(a.id)}
                onChange={(e) => setChosen(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))}
              />
              <bdi>{a.code}</bdi> · {locale === 'ar' ? a.nameAr : a.nameEn}
              {held.has(a.id) ? <> {t('areaScheduled')}</> : null}
            </label>
          ))}
        </fieldset>
        <p className="muted">
          {t('campaignDone', {
            done: fmt.number(inspections.filter((i) => i.status === 'submitted' || i.status === 'cancelled').length),
            total: fmt.number(inspections.length),
          })}
        </p>
      </div>
    </Dialog>
  );
}

function CopyDialog({ program, onClose }: { program: ReadinessProgram; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
      onDone: (x) => {
        toast.show(x.reassignedItemIds.length ? t('copiedReassigned', { n: x.reassignedItemIds.length }) : t('copied'));
        router.push(`/readiness/${x.id}`);
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('copyTitle')}
      description={t('copyDescription')}
      onSubmit={() => copy.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={copy.isPending}>
            {t('copy')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={copy.error} />
        <Field label={t('newFirstDay')} error={fieldError(copy.error, 'startsOn')}>
          {(p) => <Input {...p} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** One readiness program (ADR 0067): its items, its readiness and the contracts it reviews. */
export default function ReadinessProgramPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
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
  const [drill, setDrill] = useState<ReadinessItem | null>(null);
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
        toast.show(t('doneToast'));
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
        toast.show(t('calledOffToast'));
        setCancelling(null);
      },
    },
  );
  const close = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/readiness/programs/{id}/close', { params: { path: { id } } })),
    { invalidate: [keys.readinessAll], onDone: () => toast.show(t('closedToast')) },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const p = program.data;
  const open = p ? p.closedAt === null : false;
  const percent = (n: number | null) => (n === null ? '—' : fmt.percent(n / 100));
  const state = (i: ReadinessItem) => {
    const s = t(`state.${i.state}`);
    if (i.decision) return t('stateDecision', { state: s, decision: label(i.decision) });
    if (i.drillOutcome) return t('stateDrill', { state: s, outcome: label(i.drillOutcome), n: fmt.number(i.drillParticipants ?? 0) });
    return s;
  };
  return (
    <>
      <PageHeader
        title={p?.title ?? t('program')}
        description={
          p
            ? t(open ? 'summary' : 'summaryClosed', { kind: label(p.kind), from: fmt.day(p.startsOn), to: fmt.day(p.endsOn) })
            : undefined
        }
        actions={
          p ? (
            <span className="row" style={{ gap: 6 }}>
              <Button onClick={() => setCopying(true)}>{t('copy')}</Button>
              {open ? (
                <>
                  <Button loading={close.isPending} onClick={() => close.mutate()}>
                    {t('close')}
                  </Button>
                  <Button variant="primary" onClick={() => setAdding(true)}>
                    {t('newItem')}
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
            <Stat label={t('stat.ready')} value={percent(p.readiness.percent)} />
            <Stat label={t('stat.done')} value={fmt.number(p.readiness.done)} />
            <Stat label={t('stat.open')} value={fmt.number(p.readiness.open)} />
            <Stat label={t('stat.calledOff')} value={fmt.number(p.readiness.cancelled)} />
            <Stat label={t('stat.budget')} value={fmt.money(p.readiness.budget)} />
          </div>
        ) : null}
      </QueryState>
      <Card flush>
        <CardHeader title={t('items')} />
        <QueryState query={items}>
          <DataTable<ReadinessItem>
            rows={items.data?.data ?? []}
            rowKey={(i) => i.id}
            empty={t('noItem')}
            columns={[
              { key: 't', header: t('col.item'), cell: (i) => i.title },
              { key: 'k', header: t('col.kind'), cell: (i) => label(i.kind) },
              { key: 'd', header: t('col.due'), cell: (i) => fmt.day(i.dueOn) },
              { key: 'e', header: t('col.estimate'), cell: (i) => (i.estimateAmount ? fmt.money(i.estimateAmount) : '—') },
              { key: 's', header: t('col.state'), cell: state },
              {
                key: 'x',
                header: <span className="visually-hidden">{t('col.actions')}</span>,
                className: 'table__actions',
                cell: (i) =>
                  open && i.state === 'open' ? (
                    <span className="row" style={{ gap: 6 }}>
                      {i.kind === 'inspection_campaign' ? (
                        <Button size="sm" onClick={() => setCampaign(i)}>
                          {t('campaign')}
                        </Button>
                      ) : i.kind === 'contract_review' ? (
                        <Button size="sm" onClick={() => setDeciding(i)}>
                          {t('decide')}
                        </Button>
                      ) : i.kind === 'drill' ? (
                        <Button size="sm" onClick={() => setDrill(i)}>
                          {t('record')}
                        </Button>
                      ) : (
                        <Button size="sm" loading={done.isPending} onClick={() => done.mutate({ itemId: i.id })}>
                          {t('done')}
                        </Button>
                      )}
                      <Button size="sm" onClick={() => setCancelling(i)}>
                        {t('callOff')}
                      </Button>
                    </span>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      <Card flush>
        <CardHeader title={t('contractsDue')} />
        <QueryState query={due}>
          <DataTable<ContractDue>
            rows={due.data?.data ?? []}
            rowKey={(x) => x.contractId}
            empty={t('noContractDue')}
            columns={[
              { key: 'c', header: t('col.contract'), cell: (x) => x.code },
              { key: 'k', header: t('col.kind'), cell: (x) => label(x.kind) },
              { key: 'e', header: t('col.ends'), cell: (x) => fmt.day(x.endsOn) },
              { key: 'r', header: t('col.review'), cell: (x) => (x.itemId ? t('planned') : t('notYet')) },
            ]}
          />
        </QueryState>
      </Card>
      {adding && p ? <NewItemDialog program={p} due={due.data?.data ?? []} onClose={() => setAdding(false)} /> : null}
      {copying && p ? <CopyDialog program={p} onClose={() => setCopying(false)} /> : null}
      {campaign ? <CampaignDialog item={campaign} onClose={() => setCampaign(null)} /> : null}
      {drill ? <DrillDoneDialog item={drill} refresh={refresh} onClose={() => setDrill(null)} /> : null}
      <ReasonCodeDialog
        open={deciding !== null}
        onClose={() => setDeciding(null)}
        title={t('decidedTitle')}
        codes={DECISIONS}
        confirmLabel={t('record')}
        pending={done.isPending}
        error={<ErrorAlert error={done.error} />}
        onConfirm={(code) => deciding && done.mutate({ itemId: deciding.id, decision: code as (typeof DECISIONS)[number] })}
      />
      <ReasonCodeDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title={t('callOffTitle')}
        codes={REASON_CODES.readinessItemCancel}
        confirmLabel={t('callOff')}
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(code) => cancelling && cancel.mutate({ itemId: cancelling.id, reasonCode: code })}
      />
    </>
  );
}
