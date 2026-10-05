import { ApiProperty } from '@nestjs/swagger';
import type { SlaSettingsView } from '../sla-settings.service';

export class SlaSettingsResponse {
  @ApiProperty({
    type: Boolean,
    description: 'Off until the manager turns it on.',
  })
  slaEnabled: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'The last time it was turned on: no clock starts before it (nothing is backdated).',
  })
  enabledAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(s: SlaSettingsView): SlaSettingsResponse {
    return {
      slaEnabled: s.slaEnabled,
      enabledAt: s.enabledAt,
      updatedAt: s.updatedAt,
    };
  }
}

/** One priority's targets on a category. */
export class SlaTargetView {
  @ApiProperty({ type: Number })
  responseMinutes: number;
  @ApiProperty({ type: Number })
  resolutionMinutes: number;
}

/** A category's targets, per priority. */
export class SlaTargetsView {
  @ApiProperty({ type: SlaTargetView })
  emergency: SlaTargetView;
  @ApiProperty({ type: SlaTargetView })
  urgent: SlaTargetView;
  @ApiProperty({ type: SlaTargetView })
  normal: SlaTargetView;
}
