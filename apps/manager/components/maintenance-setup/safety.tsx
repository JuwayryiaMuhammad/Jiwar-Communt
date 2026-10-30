'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, Checkbox, DataTable, Dialog, Field, Input, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type AssetType, type Category } from '@/lib/queries';

const HAZARDS = REASON_CODES.workHazard;
type Hazard = (typeof HAZARDS)[number];

/** Which hazards a category's or an asset type's work needs a permit for. */
function HazardsDialog({
  title,
  current,
  onSave,
  pending,
  error,
  onClose,
}: {
  title: string;
  current: string[];
  onSave: (hazards: Hazard[]) => void;
  pending: boolean;
  error: unknown;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<Hazard[]>(HAZARDS.filter((h) => current.includes(h)));
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description="Its work starts only with an approved permit, not expired, for each of these."
      onSubmit={() => onSave(chosen)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={pending}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={error} />
        {HAZARDS.map((h) => (
          <Checkbox
            key={h}
            label={humanize(h)}
            checked={chosen.includes(h)}
            onChange={(e) => setChosen(e.target.checked ? [...chosen, h] : chosen.filter((x) => x !== h))}
          />
        ))}
      </div>
    </Dialog>
  );
}

function InstructionsDialog({ category, onClose }: { category: Category; onClose: () => void }) {
  const toast = useToast();
  const versions = useQuery({
    queryKey: keys.safetyInstructions(category.id),
    queryFn: () => fetchers.safetyInstructions(category.id),
  });
  const latest = versions.data?.[0];
  const [f, setF] = useState({ textEn: '', textAr: '' });
  const publish = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/categories/{id}/safety-instructions', {
          params: { path: { id: category.id } },
          body: { textEn: f.textEn.trim(), textAr: f.textAr.trim() },
        }),
      ),
    {
      invalidate: [keys.safetyInstructions(category.id)],
      onDone: (i) => {
        toast.show(`Version ${i.version} published: technicians acknowledge it before they start.`);
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`Safety instructions · ${category.nameEn}`}
      description="Each change is the next version; a version never changes. A technician acknowledges the current one for each ticket before the work starts or resumes."
      onSubmit={() => publish.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button type="submit" variant="primary" loading={publish.isPending}>
            Publish the next version
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={publish.error} />
        <QueryState query={versions}>
          {latest ? (
            <p className="muted">
              Version {latest.version}, {formatDateTime(latest.createdAt)}: {latest.textEn}
            </p>
          ) : (
            <p className="muted">None yet.</p>
          )}
        </QueryState>
        <Field label="In English" error={fieldError(publish.error, 'textEn')}>
          {(p) => <Input {...p} value={f.textEn} onChange={(e) => setF({ ...f, textEn: e.target.value })} />}
        </Field>
        <Field label="In Arabic" error={fieldError(publish.error, 'textAr')}>
          {(p) => <Input {...p} dir="rtl" value={f.textAr} onChange={(e) => setF({ ...f, textAr: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * Field safety's setup (ADR 0067): the hazards each category's work and
 * each asset type's needs a permit for, and each category's safety
 * instructions.
 */
export function Safety() {
  const { can } = usePermissions();
  const categories = useQuery({ queryKey: keys.categories, queryFn: fetchers.categories });
  const types = useQuery({ queryKey: keys.assetTypes, queryFn: fetchers.assetTypes, enabled: can('assets.manage') });
  const [hazardsOf, setHazardsOf] = useState<{ kind: 'category'; row: Category } | { kind: 'type'; row: AssetType } | null>(null);
  const [instructing, setInstructing] = useState<Category | null>(null);
  const save = useAction(
    (hazards: Hazard[]) =>
      hazardsOf?.kind === 'type'
        ? unwrap(
            api.PUT('/api/v1/maintenance/asset-types/{id}/permit-hazards', {
              params: { path: { id: hazardsOf.row.id } },
              body: { hazards },
            }),
          )
        : unwrap(
            api.PUT('/api/v1/maintenance/categories/{id}/permit-hazards', {
              params: { path: { id: hazardsOf!.row.id } },
              body: { hazards },
            }),
          ),
    { invalidate: [keys.categories, keys.assetTypes], onDone: () => setHazardsOf(null) },
  );
  const list = (hazards: string[]) => (hazards.length ? hazards.map(humanize).join(', ') : 'No permit needed');
  return (
    <div className="stack">
      <Card flush>
        <CardHeader title="Categories" />
        <CardBody>
          <QueryState query={categories}>
            <DataTable<Category>
              rows={categories.data?.data ?? []}
              rowKey={(c) => c.id}
              empty="No category"
              columns={[
                { key: 'n', header: 'Category', cell: (c) => c.nameEn },
                { key: 'h', header: 'Needs a permit for', cell: (c) => list(c.requiresPermit) },
                {
                  key: 'x',
                  header: <span className="visually-hidden">Actions</span>,
                  className: 'table__actions',
                  cell: (c) => (
                    <span className="row" style={{ gap: 6 }}>
                      <Button size="sm" onClick={() => setHazardsOf({ kind: 'category', row: c })}>
                        Hazards
                      </Button>
                      {can('safety.manage') ? (
                        <Button size="sm" onClick={() => setInstructing(c)}>
                          Instructions
                        </Button>
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />
          </QueryState>
        </CardBody>
      </Card>
      {can('assets.manage') ? (
        <Card flush>
          <CardHeader title="Asset types" />
          <CardBody>
            <QueryState query={types}>
              <DataTable<AssetType>
                rows={types.data?.data ?? []}
                rowKey={(t) => t.id}
                empty="No asset type"
                columns={[
                  { key: 'n', header: 'Asset type', cell: (t) => t.nameEn },
                  { key: 'h', header: 'Needs a permit for', cell: (t) => list(t.requiresPermit) },
                  {
                    key: 'x',
                    header: <span className="visually-hidden">Actions</span>,
                    className: 'table__actions',
                    cell: (t) => (
                      <Button size="sm" onClick={() => setHazardsOf({ kind: 'type', row: t })}>
                        Hazards
                      </Button>
                    ),
                  },
                ]}
              />
            </QueryState>
          </CardBody>
        </Card>
      ) : null}
      {hazardsOf ? (
        <HazardsDialog
          title={`What ${hazardsOf.row.nameEn} needs a permit for`}
          current={hazardsOf.row.requiresPermit}
          onSave={(h) => save.mutate(h)}
          pending={save.isPending}
          error={save.error}
          onClose={() => setHazardsOf(null)}
        />
      ) : null}
      {instructing ? <InstructionsDialog category={instructing} onClose={() => setInstructing(null)} /> : null}
    </div>
  );
}
