import { ApiProperty } from '@nestjs/swagger';
import type { DispatchSettingsView } from '../dispatch-settings.service';

export class DispatchSettingsResponse {
  @ApiProperty({
    type: Boolean,
    description: 'Off until the manager turns it on.',
  })
  autoDispatchEnabled: boolean;
  @ApiProperty({ type: Number, description: 'Weight of an assigned ticket.' })
  weightAssigned: number;
  @ApiProperty({ type: Number, description: 'Weight of a ticket in progress.' })
  weightInProgress: number;
  @ApiProperty({ type: Number, description: 'Weight of a ticket on hold.' })
  weightOnHold: number;
  @ApiProperty({ type: Number })
  multiplierNormal: number;
  @ApiProperty({ type: Number })
  multiplierUrgent: number;
  @ApiProperty({ type: Number })
  multiplierEmergency: number;

  static from(s: DispatchSettingsView): DispatchSettingsResponse {
    return {
      autoDispatchEnabled: s.autoDispatchEnabled,
      weightAssigned: s.weightAssigned,
      weightInProgress: s.weightInProgress,
      weightOnHold: s.weightOnHold,
      multiplierNormal: s.multiplierNormal,
      multiplierUrgent: s.multiplierUrgent,
      multiplierEmergency: s.multiplierEmergency,
    };
  }
}
