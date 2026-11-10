'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, Checkbox, DataTable, Dialog, Field, Input, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type AssetType, type Category } from '@/lib/queries';
import ar from '@/messages/ar/ms-safety';
import en from '@/messages/en/ms-safety';
import { useNameOf } from './names';

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
  const t = useT(en, ar);
  const common = useCommonT();
  const label = useLabel();
  const [chosen, setChosen] = useState<Hazard[]>(HAZARDS.filter((h) => current.includes(h)));
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={t('hazardsDescription')}
      onSubmit={() => onSave(chosen)}
      footer={
        <>
          <Button onClick={onClose}>{common('cancel')}</Button>
          <Button type="submit" variant="primary" loading={pending}>
            {common('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={error} />
        {HAZARDS.map((h) => (
          <Checkbox
            key={h}
            label={label(h)}
            checked={chosen.includes(h)}
            onChange={(e) => setChosen(e.target.checked ? [...chosen, h] : chosen.filter((x) => x !== h))}
          />
        ))}
      </div>
    </Dialog>
  );
}

function InstructionsDialog({ category, onClose }: { category: Category; onClose: () => void }) {
  const t = useT(en, ar);
  const common = useCommonT();
  const fmt = useFormat();
  const nameOf = useNameOf();
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
        toast.show(t('published', { version: i.version }));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('instructionsTitle', { name: nameOf(category) })}
      description={t('instructionsDescription')}
      onSubmit={() => publish.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{common('close')}</Button>
          <Button type="submit" variant="primary" loading={publish.isPending}>
            {t('publish')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={publish.error} />
        <QueryState query={versions}>
          {latest ? (
            <p className="muted">{t('latest', { version: latest.version, when: fmt.dateTime(latest.createdAt), text: latest.textEn })}</p>
          ) : (
            <p className="muted">{t('noneYet')}</p>
          )}
        </QueryState>
        <Field label={t('inEnglish')} error={fieldError(publish.error, 'textEn')}>
          {(p) => <Input {...p} dir="ltr" value={f.textEn} onChange={(e) => setF({ ...f, textEn: e.target.value })} />}
        </Field>
        <Field label={t('inArabic')} error={fieldError(publish.error, 'textAr')}>
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
  const t = useT(en, ar);
  const fmt = useFormat();
  const common = useCommonT();
  const label = useLabel();
  const nameOf = useNameOf();
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
  const list = (hazards: string[]) => (hazards.length ? fmt.list(hazards.map(label)) : t('noPermit'));
  return (
    <div className="stack">
      <Card flush>
        <CardHeader title={t('categories')} />
        <CardBody>
          <QueryState query={categories}>
            <DataTable<Category>
              rows={categories.data?.data ?? []}
              rowKey={(c) => c.id}
              empty={t('emptyCategories')}
              columns={[
                { key: 'n', header: t('col.category'), cell: (c) => nameOf(c) },
                { key: 'h', header: t('col.permit'), cell: (c) => list(c.requiresPermit) },
                {
                  key: 'x',
                  header: <span className="visually-hidden">{common('actions')}</span>,
                  className: 'table__actions',
                  cell: (c) => (
                    <span className="row" style={{ gap: 6 }}>
                      <Button size="sm" onClick={() => setHazardsOf({ kind: 'category', row: c })}>
                        {t('hazards')}
                      </Button>
                      {can('safety.manage') ? (
                        <Button size="sm" onClick={() => setInstructing(c)}>
                          {t('instructions')}
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
          <CardHeader title={t('assetTypes')} />
          <CardBody>
            <QueryState query={types}>
              <DataTable<AssetType>
                rows={types.data?.data ?? []}
                rowKey={(x) => x.id}
                empty={t('emptyTypes')}
                columns={[
                  { key: 'n', header: t('col.assetType'), cell: (x) => nameOf(x) },
                  { key: 'h', header: t('col.permit'), cell: (x) => list(x.requiresPermit) },
                  {
                    key: 'x',
                    header: <span className="visually-hidden">{common('actions')}</span>,
                    className: 'table__actions',
                    cell: (x) => (
                      <Button size="sm" onClick={() => setHazardsOf({ kind: 'type', row: x })}>
                        {t('hazards')}
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
          title={t('hazardsTitle', { name: nameOf(hazardsOf.row) })}
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
