'use client';

import { formatDateTime, humanize, relativeTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Field, PageHeader, Segmented, Select, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { NewTicketDialog } from '@/components/maintenance/new-ticket-dialog';
import { personName, PriorityBadge, SlaBadges, ticketPlace } from '@/components/maintenance/sla';
import { TechnicianPicker } from '@/components/maintenance/technician-picker';
import { Technicians } from '@/components/maintenance/technicians';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Ticket, type TicketFilters, type TicketPriority, type TicketStatus } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';

const TABS = ['tickets', 'technicians'] as const;
type Tab = (typeof TABS)[number];

const VIEWS = ['open', 'unassigned', 'overdue', 'escalated', 'all'] as const;
type View = (typeof VIEWS)[number];
const STATUSES: TicketStatus[] = ['new', 'assigned', 'en_route', 'in_progress', 'on_hold', 'completed', 'closed', 'cancelled'];
/** Still someone's to move: what "Open" shows, since the API filters one status at a time. */
const OPEN: ReadonlySet<string> = new Set(['new', 'assigned', 'en_route', 'in_progress', 'on_hold', 'completed']);

function Queue() {
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
    overdue: view === 'overdue' ? 'true' : '',
    escalated: view === 'escalated' ? 'true' : '',
  };
  const categories = useQuery({ queryKey: keys.ticketCategories, queryFn: fetchers.ticketCategories });
  const list = useCursorList(keys.tickets(filters), (c) => fetchers.tickets(filters, c), { refetchInterval: 60_000 });
  // "Open" hides what is finished, on the pages loaded so far.
  const rows = view === 'open' && !status ? list.rows?.filter((t) => OPEN.has(t.status)) : list.rows;

  return (
    <>
      <div className="toolbar">
        <Segmented<View>
          label="Tickets shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'unassigned', label: 'Unassigned' },
            { value: 'overdue', label: 'Overdue' },
            { value: 'escalated', label: 'Escalated' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Field label="Status">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as TicketStatus | '')}>
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Priority">
          {(p) => (
            <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority | '')}>
              <option value="">Any priority</option>
              <option value="emergency">Emergency</option>
              <option value="urgent">Urgent</option>
              <option value="normal">Normal</option>
            </Select>
          )}
        </Field>
        <Field label="Category">
          {(p) => (
            <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Any category</option>
              {(categories.data?.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nameEn}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Technician">
          {(p) => (
            <TechnicianPicker
              {...p}
              placeholder="Any technician"
              style={{ maxWidth: 220 }}
              value={technicianId}
              disabled={view === 'unassigned'}
              onChange={(e) => setTechnician(e.target.value)}
            />
          )}
        </Field>
        <span className="spacer" />
        {can('residents.read', 'units.read') ? (
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
            New ticket
          </Button>
        ) : null}
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Ticket>
            rows={rows}
            rowKey={(t) => t.id}
            empty={
              view === 'overdue'
                ? 'No ticket is overdue'
                : view === 'escalated'
                  ? 'No ticket was escalated'
                  : view === 'unassigned'
                    ? 'No ticket is waiting for a technician'
                    : 'No ticket matches'
            }
            emptyHint={
              view === 'overdue' || view === 'escalated'
                ? 'Both lists stay empty while the compound does not measure an SLA.'
                : undefined
            }
            columns={[
              {
                key: 'number',
                header: 'Ticket',
                cell: (t) => (
                  <span className="row">
                    <Link className="table__link t-mono" style={{ whiteSpace: 'nowrap' }} href={`/maintenance/${t.id}`}>
                      {t.number}
                    </Link>
                    {t.kind === 'preventive' ? <Badge plain>Preventive</Badge> : null}
                  </span>
                ),
              },
              { key: 'place', header: 'Where', cell: (t) => ticketPlace(t) },
              {
                key: 'category',
                header: 'Category',
                cell: (t) => (t.preventiveService ? `${t.category.nameEn} · ${t.preventiveService.nameEn}` : t.category.nameEn),
              },
              { key: 'priority', header: 'Priority', cell: (t) => <PriorityBadge priority={t.priority} /> },
              {
                key: 'status',
                header: 'Status',
                cell: (t) => (
                  <span className="row" style={{ gap: 6 }}>
                    <StatusBadge status={t.status} />
                    {t.holdReason ? <span className="t-secondary">{humanize(t.holdReason)}</span> : null}
                    {t.rejectionCount > 0 ? <Badge tone="terracotta">Rejected ×{t.rejectionCount}</Badge> : null}
                  </span>
                ),
              },
              {
                key: 'technician',
                header: 'Technician',
                cell: (t) => (t.technician ? personName(t.technician) : <span className="t-secondary">Unassigned</span>),
              },
              { key: 'sla', header: 'SLA', cell: (t) => <SlaBadges ticket={t} /> },
              {
                key: 'opened',
                header: 'Opened',
                cell: (t) => (
                  <span title={formatDateTime(t.createdAt)} style={{ whiteSpace: 'nowrap' }}>
                    {relativeTime(t.createdAt)}
                  </span>
                ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <NewTicketDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(ticket) => {
          setCreating(false);
          toast.show(`Ticket ${ticket.number} is open.`);
          router.push(`/maintenance/${ticket.id}`);
        }}
      />
    </>
  );
}

function MaintenanceView() {
  const [tab, setTab] = useTab(TABS, 'tickets');
  return (
    <>
      <PageHeader
        title="Maintenance"
        description="The compound's tickets: who has each one, what is late, and who can take the next."
        actions={
          <Segmented<Tab>
            label="Maintenance"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'tickets', label: 'Tickets' },
              { value: 'technicians', label: 'Technicians' },
            ]}
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
