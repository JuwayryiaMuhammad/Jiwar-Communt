'use client';

import type { Schema } from '@jiwar/api';
import { Button, Checkbox, Field, Select } from '@jiwar/ui';
import { Trash2 } from 'lucide-react';
import { UnitPicker } from './unit-picker';

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
  error?: string;
}) {
  return (
    <div className="stack stack--sm">
      <div className="form__row" style={{ alignItems: 'end' }}>
        <Field label="Unit" error={error}>
          {(p) => <UnitPicker {...p} value={value.unitId} onChange={(e) => onChange({ ...value, unitId: e.target.value })} />}
        </Field>
        <Field label="As">
          {(p) => (
            <Select
              {...p}
              value={value.occupancyType}
              onChange={(e) => onChange({ ...value, occupancyType: e.target.value as OccupancyInput['occupancyType'] })}
            >
              <option value="owner">Owner</option>
              <option value="tenant">Tenant</option>
            </Select>
          )}
        </Field>
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Checkbox
          label="Lives in the unit"
          checked={value.resides ?? true}
          onChange={(e) => onChange({ ...value, resides: e.target.checked })}
        />
        {onRemove ? (
          <Button size="sm" variant="text" icon={<Trash2 aria-hidden />} onClick={onRemove}>
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
}

