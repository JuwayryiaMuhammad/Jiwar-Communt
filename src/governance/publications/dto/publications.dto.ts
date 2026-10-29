import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import {
  BOARD_NOTICE_BODY_MAX,
  BOARD_NOTICE_TITLE_MAX,
} from '../../../engagement';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';

export const PUBLICATION_KINDS = ['decision', 'minutes'] as const;

const text = (max: number, description?: string) =>
  ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: 1,
    maxLength: max,
    description,
  });

export class BoardPublicationTextDto {
  @text(BOARD_NOTICE_TITLE_MAX, 'English, Arabic or both, each with its body.')
  @IsOptional()
  @IsString()
  titleEn?: string | null;

  @text(BOARD_NOTICE_BODY_MAX)
  @IsOptional()
  @IsString()
  bodyEn?: string | null;

  @text(BOARD_NOTICE_TITLE_MAX)
  @IsOptional()
  @IsString()
  titleAr?: string | null;

  @text(BOARD_NOTICE_BODY_MAX)
  @IsOptional()
  @IsString()
  bodyAr?: string | null;
}

export class PublishBoardPublicationDto extends BoardPublicationTextDto {
  @ApiProperty({ enum: PUBLICATION_KINDS, enumName: 'BoardPublicationKind' })
  @IsIn(PUBLICATION_KINDS, withParams({ allowed: [...PUBLICATION_KINDS] }))
  kind: (typeof PUBLICATION_KINDS)[number];

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    example: '2026-11-01',
    description:
      'The local day the board decided or met: today, or up to a year ago (DAY_OUT_OF_RANGE).',
  })
  @IsString()
  @IsLocalDate()
  decidedOn: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'A PDF of the caller’s, uploaded as `community_attachment` (FILE_NOT_AVAILABLE; FILE_TYPE_NOT_ALLOWED when not a PDF).',
  })
  @IsOptional()
  @IsUUID()
  attachmentFileId?: string;
}

export class BoardPublicationsQueryDto extends PageQueryDto {}
