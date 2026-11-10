'use client';

import type { Schema } from '@jiwar/api';
import { useT } from '@jiwar/i18n';
import { Button, Checkbox, Field, Select, useCommonT } from '@jiwar/ui';
import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { UnitPicker } from './unit-picker';
import ar from '@/messages/ar/shell-components';
import en from '@/messages/en/shell-components';

type OccupancyInput = Schema<'OccupancyInputDto'>;

export const emptyOccupancy: OccupancyInput = { unitId: '', occupancyType: 'owner', resides: true };

export function OccupancyRow({
  value,
  onChange,
  onRemove,
  error,
}: {
  value: OccupancyInput;
  onChange: (v: OccupancyInput) => void;
  onRemove?: () => void;
  error?: ReactNode;
}) {
  const t = useT(en, ar);
  const c = useCommonT();
  return (
    <div className="stack stack--sm">
      <div className="form__row" style={{ alignItems: 'end' }}>
        <Field label={c('unit')} error={error}>
          {(p) => <UnitPicker {...p} value={value.unitId} onChange={(e) => onChange({ ...value, unitId: e.target.value })} />}
        </Field>
        <Field label={t('occupancyAs')}>
          {(p) => (
            <Select
              {...p}
              value={value.occupancyType}
              onChange={(e) => onChange({ ...value, occupancyType: e.target.value as OccupancyInput['occupancyType'] })}
            >
              <option value="owner">{c('owner')}</option>
              <option value="tenant">{c('tenant')}</option>
            </Select>
          )}
        </Field>
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Checkbox
          label={t('residesHere')}
          checked={value.resides ?? true}
          onChange={(e) => onChange({ ...value, resides: e.target.checked })}
        />
        {onRemove ? (
          <Button size="sm" variant="text" icon={<Trash2 aria-hidden />} onClick={onRemove}>
            {c('remove')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

