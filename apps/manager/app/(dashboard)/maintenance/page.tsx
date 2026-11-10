'use client';

import { ErrorAlert, LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Field, Input, PageHeader, Segmented, Select, StatusBadge, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Download, Plus, Wrench } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { NewTicketDialog } from '@/components/maintenance/new-ticket-dialog';
import { WorkOrderDialog } from '@/components/maintenance/work-order-dialog';
import { download } from '@/lib/download';
import { PriorityBadge, SlaBadges, useTicketWords } from '@/components/maintenance/sla';
import { TechnicianPicker } from '@/components/maintenance/technician-picker';
import { Technicians } from '@/components/maintenance/technicians';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Ticket, type TicketFilters, type TicketPriority, type TicketStatus } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';
import ar from '@/messages/ar/maint-queue';
import en from '@/messages/en/maint-queue';

const TABS = ['tickets', 'technicians'] as const;
type Tab = (typeof TABS)[number];

const VIEWS = ['open', 'unassigned', 'overdue', 'escalated', 'all'] as const;
type View = (typeof VIEWS)[number];
const STATUSES: TicketStatus[] = ['new', 'assigned', 'en_route', 'in_progress', 'on_hold', 'completed', 'closed', 'cancelled'];
const PRIORITIES: TicketPriority[] = ['emergency', 'urgent', 'normal'];

function Queue() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const words = useTicketWords();
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { can } = usePermissions();
  const [view, setView] = useState<View>('open');
  const [status, setStatus] = useState<TicketStatus | ''>('');
  const [priority, setPriority] = useState<TicketPriority | ''>('');
  const [categoryId, setCategoryId] = useState('');
  const [creating, setCreating] = useState(false);
  const [ordering, setOrdering] = useState(false);
  // ADR 0076: a building (ADR 0072), and a number or a unit code.
  // ADR 0081: the complaints map links a building here.
  const [buildingId, setBuildingId] = useState(params.get('buildingId') ?? '');
  const [q, setQ] = useState('');
  const [csvError, setCsvError] = useState<unknown>(null);
  // A technician's tickets are linked from the technicians tab.
  const technicianId = params.get('technicianId') ?? '';
  const setTechnician = (id: string) => router.replace(id ? `${pathname}?technicianId=${id}` : pathname, { scroll: false });

  const filters: TicketFilters = {
    // Waiting for a technician means new: a ticket cancelled before anyone
    // took it has no technician either, and is not waiting.
    status: view === 'unassigned' && !status ? 'new' : status,
    priority,
    categoryId,
    technicianId: view === 'unassigned' ? '' : technicianId,
    unassigned: view === 'unassigned' ? 'true' : '',
    // Not closed, not cancelled: decided by the API, so every page is full.
    // An escalation of a finished ticket needs nobody, so "Escalated" asks
    // for the open ones too. A status picked by hand says what to show.
    open: (view === 'open' || view === 'escalated') && !status ? 'true' : '',
    overdue: view === 'overdue' ? 'true' : '',
    escalated: view === 'escalated' ? 'true' : '',
    buildingId,
    q: q.trim(),
  };
  const categories = useQuery({ queryKey: keys.ticketCategories, queryFn: fetchers.ticketCategories });
  const buildings = useQuery({ queryKey: keys.buildings, queryFn: fetchers.buildings });
  const list = useCursorList(keys.tickets(filters), (c) => fetchers.tickets(filters, c), { refetchInterval: 60_000 });

  return (
    <>
      <div className="toolbar">
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        />
        <Field label={t('status')}>
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as TicketStatus | '')}>
              <option value="">{t('anyStatus')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('priority')}>
          {(p) => (
            <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority | '')}>
              <option value="">{t('anyPriority')}</option>
              {PRIORITIES.map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('category')}>
          {(p) => (
            <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{t('anyCategory')}</option>
              {(categories.data?.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nameEn}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('technician')}>
          {(p) => (
            <TechnicianPicker
              {...p}
              placeholder={t('anyTechnician')}
              style={{ maxWidth: 220 }}
              value={technicianId}
              disabled={view === 'unassigned'}
              onChange={(e) => setTechnician(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('building')}>
          {(p) => (
            <Select {...p} value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>
              <option value="">{t('anyBuilding')}</option>
              {(buildings.data?.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('search')}>
          {(p) => <Input {...p} value={q} placeholder={t('searchPlaceholder')} onChange={(e) => setQ(e.target.value)} />}
        </Field>
        <span className="spacer" />
        <Button
          icon={<Download aria-hidden />}
          onClick={() => {
            setCsvError(null);
            const to = new Date().toISOString().slice(0, 10);
            const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
            download('/api/v1/maintenance/tickets/export', { ...filters, from, to }, `tickets-${from}-${to}.csv`).catch(
              setCsvError,
            );
          }}
        >
          {t('export')}
        </Button>
        {can('tickets.dispatch') ? (
          <Button icon={<Wrench aria-hidden />} onClick={() => setOrdering(true)}>
            {t('newWorkOrder')}
          </Button>
        ) : null}
        {can('residents.read', 'units.read') ? (
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
            {t('newTicket')}
          </Button>
        ) : null}
      </div>
      {csvError ? <ErrorAlert error={csvError} /> : null}
      <Card flush>
        <QueryState query={list}>
          <DataTable<Ticket>
            rows={list.rows}
            rowKey={(tk) => tk.id}
            empty={
              view === 'overdue'
                ? t('emptyOverdue')
                : view === 'escalated'
                  ? t('emptyEscalated')
                  : view === 'unassigned'
                    ? t('emptyUnassigned')
                    : t('emptyMatch')
            }
            emptyHint={view === 'overdue' || view === 'escalated' ? t('emptySlaHint') : undefined}
            columns={[
              {
                key: 'number',
                header: t('col.ticket'),
                cell: (tk) => (
                  <span className="row">
                    <Link className="table__link t-mono" style={{ whiteSpace: 'nowrap' }} href={`/maintenance/${tk.id}`}>
                      {tk.number}
                    </Link>
                    {tk.kind === 'preventive' ? <Badge plain>{t('preventive')}</Badge> : null}
                  </span>
                ),
              },
              { key: 'place', header: t('col.where'), cell: (tk) => words.place(tk) },
              {
                key: 'category',
                header: t('col.category'),
                cell: (tk) => (tk.preventiveService ? `${tk.category.nameEn} · ${tk.preventiveService.nameEn}` : tk.category.nameEn),
              },
              { key: 'priority', header: t('col.priority'), cell: (tk) => <PriorityBadge priority={tk.priority} /> },
              {
                key: 'status',
                header: t('col.status'),
                cell: (tk) => (
                  <span className="row" style={{ gap: 6 }}>
                    <StatusBadge status={tk.status} />
                    {tk.holdReason ? <span className="t-secondary">{label(tk.holdReason)}</span> : null}
                    {tk.rejectionCount > 0 ? <Badge tone="terracotta">{t('rejected', { n: tk.rejectionCount })}</Badge> : null}
                  </span>
                ),
              },
              {
                key: 'technician',
                header: t('col.technician'),
                cell: (tk) => (tk.technician ? words.person(tk.technician) : <span className="t-secondary">{t('unassigned')}</span>),
              },
              { key: 'sla', header: t('col.sla'), cell: (tk) => <SlaBadges ticket={tk} /> },
              {
                key: 'opened',
                header: t('col.opened'),
                cell: (tk) => (
                  <span title={fmt.dateTime(tk.createdAt)} style={{ whiteSpace: 'nowrap' }}>
                    {fmt.relative(tk.createdAt)}
                  </span>
                ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <WorkOrderDialog
        open={ordering}
        onClose={() => setOrdering(false)}
        onCreated={(ticket) => {
          setOrdering(false);
          toast.show(t('workOrderOpen', { number: ticket.number }));
          router.push(`/maintenance/${ticket.id}`);
        }}
      />
      <NewTicketDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(ticket) => {
          setCreating(false);
          toast.show(t('ticketOpen', { number: ticket.number }));
          router.push(`/maintenance/${ticket.id}`);
        }}
      />
    </>
  );
}

function MaintenanceView() {
  const t = useT(en, ar);
  const [tab, setTab] = useTab(TABS, 'tickets');
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Segmented<Tab>
            label={t('title')}
            value={tab}
            onChange={setTab}
            options={TABS.map((v) => ({ value: v, label: t(`tab.${v}`) }))}
          />
        }
      />
      {tab === 'tickets' ? <Queue /> : <Technicians />}
    </>
  );
}

export default function MaintenancePage() {
  return (
    <Suspense>
      <MaintenanceView />
    </Suspense>
  );
}
