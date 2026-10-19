import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  ACCURACY_M,
  LATITUDE,
  LONGITUDE,
  MAX_NOTE_MEDIA,
  MAX_NOTE_PHOTOS,
  NOTE_TEXT,
} from '../patrol-rules';

export const SCAN_METHODS = ['qr', 'nfc', 'manual'] as const;
const decimals = { maxDecimalPlaces: 7 };

/** Where the device was, as it says. */
class DevicePositionDto {
  @ApiPropertyOptional({
    type: Number,
    minimum: LATITUDE.min,
    maximum: LATITUDE.max,
    description: 'With `lng`; none when the device has no fix.',
  })
  @IsOptional()
  @IsNumber(decimals, withParams({ ...LATITUDE }))
  @Min(LATITUDE.min, withParams({ ...LATITUDE }))
  @Max(LATITUDE.max, withParams({ ...LATITUDE }))
  lat?: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: LONGITUDE.min,
    maximum: LONGITUDE.max,
  })
  @IsOptional()
  @IsNumber(decimals, withParams({ ...LONGITUDE }))
  @Min(LONGITUDE.min, withParams({ ...LONGITUDE }))
  @Max(LONGITUDE.max, withParams({ ...LONGITUDE }))
  lng?: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: ACCURACY_M.min,
    maximum: ACCURACY_M.max,
    description: 'Metres, as the device reports it; with a position only.',
  })
  @IsOptional()
  @IsNumber({}, withParams({ ...ACCURACY_M }))
  @Min(ACCURACY_M.min, withParams({ ...ACCURACY_M }))
  @Max(ACCURACY_M.max, withParams({ ...ACCURACY_M }))
  accuracyM?: number;
}

export class ScanDto extends DevicePositionDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'The app’s own id (UUIDv7), made when the guard scanned: sent again (offline, a retry), it records once and answers the same.',
  })
  @IsUUID()
  id: string;

  @ApiProperty({ enum: SCAN_METHODS, enumName: 'PatrolScanMethod' })
  @IsIn(SCAN_METHODS)
  method: (typeof SCAN_METHODS)[number];

  @ApiPropertyOptional({
    type: String,
    example:
      'JWK1.0199c3d2-6f1a-7c3e-9a51-3b2f6e8d1c40.q3Jzx8b7m2Kd9PwS0aLr5TnYc4Ve1Hu6Gi8Fo0Bj2Ek',
    description:
      'What the QR or the NFC tag carries (`qr`, `nfc`). Anything else answers 422 PATROL_CHECKPOINT_INVALID.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 256, withParams({ min: 1, max: 256 }))
  payload?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'By hand (`manual`): the checkpoint, with a reason’s code.',
  })
  @IsOptional()
  @IsUUID()
  checkpointId?: string;

  @ApiPropertyOptional({
    enum: [...REASON_CODES.patrolManualScan],
    description: 'By hand only (REASON_REQUIRED).',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'The device’s time of the scan: inside the run’s lifetime, two minutes either side (422 PATROL_SCAN_OUT_OF_WINDOW).',
  })
  @Type(() => Date)
  @IsDate()
  scannedAt: Date;
}

export class NoteDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The app’s own id (UUIDv7): sent again, it records once.',
  })
  @IsUUID()
  id: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A scan of this run (INVALID_VALUE); one note each.',
  })
  @IsUUID()
  scanId: string;

  @ApiProperty({
    enum: [...REASON_CODES.patrolNoteOutcome],
    enumName: 'PatrolNoteOutcome',
  })
  @IsIn([...REASON_CODES.patrolNoteOutcome])
  outcome: (typeof REASON_CODES.patrolNoteOutcome)[number];

  @ApiPropertyOptional({
    type: String,
    minLength: NOTE_TEXT.min,
    maxLength: NOTE_TEXT.max,
  })
  @IsOptional()
  @IsString()
  @Length(NOTE_TEXT.min, NOTE_TEXT.max, withParams({ ...NOTE_TEXT }))
  text?: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  notedAt: Date;

  @ApiPropertyOptional({
    type: [String],
    description: `Finalized \`patrol_photo\` files of the caller, ${MAX_NOTE_PHOTOS} at most.`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_NOTE_PHOTOS, withParams({ min: 0, max: MAX_NOTE_PHOTOS }))
  @IsUUID(undefined, { each: true })
  photoFileIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: `Finalized recordings of the caller (ADR 0056), ${MAX_NOTE_MEDIA} at most: \`patrol_note_audio\` (audio/mp4) or \`patrol_note_video\` (video/mp4, video/quicktime), within the gate’s seconds and megabytes (MEDIA_TOO_LONG, FILE_TOO_LARGE).`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_NOTE_MEDIA, withParams({ min: 0, max: MAX_NOTE_MEDIA }))
  @IsUUID(undefined, { each: true })
  mediaFileIds?: string[];
}
