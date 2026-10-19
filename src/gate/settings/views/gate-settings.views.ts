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

  @ApiProperty({
    type: Number,
    nullable: true,
    example: L.visitExpectedMinutes.default,
    description:
      'Minutes a visit is expected to last when its pass gives none; null: no overstay alert.',
  })
  visitExpectedMinutes: number | null;

  @ApiProperty({
    type: Number,
    example: L.geofenceExitMinutes.default,
    description:
      'Minutes outside a patrol route’s geofence that flag the exit to `patrols.manage`.',
  })
  geofenceExitMinutes: number;

  @ApiProperty({
    type: Number,
    example: L.audioMaxSeconds.default,
    description:
      'The longest sound a patrol note or an incident takes, in seconds.',
  })
  audioMaxSeconds: number;

  @ApiProperty({
    type: Number,
    example: L.videoMaxSeconds.default,
    description:
      'The longest video a patrol note or an incident takes, in seconds.',
  })
  videoMaxSeconds: number;

  @ApiProperty({
    type: Number,
    example: L.audioMaxMb.default,
    description: 'The largest sound, in megabytes (20 at most).',
  })
  audioMaxMb: number;

  @ApiProperty({
    type: Number,
    example: L.videoMaxMb.default,
    description: 'The largest video, in megabytes (100 at most).',
  })
  videoMaxMb: number;

  static from(s: GateSettingsValues): GateSettingsResponse {
    return {
      exceptionAnswerMinutes: s.exceptionAnswerMinutes,
      exceptionEntryMinutes: s.exceptionEntryMinutes,
      visitExpectedMinutes: s.visitExpectedMinutes,
      geofenceExitMinutes: s.geofenceExitMinutes,
      audioMaxSeconds: s.audioMaxSeconds,
      videoMaxSeconds: s.videoMaxSeconds,
      audioMaxMb: s.audioMaxMb,
      videoMaxMb: s.videoMaxMb,
    };
  }
}
