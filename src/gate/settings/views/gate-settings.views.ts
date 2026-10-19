import { ApiProperty } from '@nestjs/swagger';
import {
  GATE_SETTING_LIMITS as L,
  type GateSettingsValues,
} from '../gate-settings-rules';

/** The gate's settings (ADR 0056). */
export class GateSettingsResponse {
  @ApiProperty({
    type: Number,
    example: L.exceptionAnswerMinutes.default,
    description: 'Minutes the management has to answer a field exception.',
  })
  exceptionAnswerMinutes: number;

  @ApiProperty({
    type: Number,
    example: L.exceptionEntryMinutes.default,
    description: 'Minutes an approved field exception lets its entry in.',
  })
  exceptionEntryMinutes: number;

  static from(s: GateSettingsValues): GateSettingsResponse {
    return {
      exceptionAnswerMinutes: s.exceptionAnswerMinutes,
      exceptionEntryMinutes: s.exceptionEntryMinutes,
    };
  }
}
