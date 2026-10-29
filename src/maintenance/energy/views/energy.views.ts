import { ApiProperty } from '@nestjs/swagger';
import type { Meter } from '@prisma/client';
import { REASON_CODES } from '../../../core/common/reasons';
import { ofDateColumnOrNull } from '../../schedules/local-dates';
import {
  METER_KINDS,
  METER_MODES,
  METER_UNITS,
  type MeterKind,
} from '../meter-rules';

export class MeterView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ enum: METER_KINDS, enumName: 'MeterKind' })
  kind: string;
  @ApiProperty({ type: String, description: 'kWh, m³, L or h.' })
  unit: string;
  @ApiProperty({ enum: METER_MODES, enumName: 'MeterMode' })
  mode: string;
  @ApiProperty({ type: String, description: 'Four decimals.' })
  multiplier: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  commonAreaId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  assetId: string | null;
  @ApiProperty({ type: String, nullable: true })
  serial: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  installedOn: string | null;
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  retiredAt: Date | null;
  @ApiProperty({
    enum: REASON_CODES.meterRetire,
    enumName: 'MeterRetireReason',
    nullable: true,
  })
  retireReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(m: Meter): MeterView {
    return {
      id: m.id,
      code: m.code,
      kind: m.kind,
      unit: METER_UNITS[m.kind as MeterKind],
      mode: m.mode,
      multiplier: m.multiplier.toFixed(4),
      unitId: m.unitId,
      commonAreaId: m.commonAreaId,
      assetId: m.assetId,
      serial: m.serial,
      installedOn: ofDateColumnOrNull(m.installedOn),
      active: m.active,
      retiredAt: m.retiredAt,
      retireReason: m.retireReason,
      createdAt: m.createdAt,
    };
  }
}
