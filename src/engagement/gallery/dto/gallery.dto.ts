import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { ALBUM_TITLE_LENGTH, CAPTION_LENGTH } from '../gallery.service';

export class CreateAlbumDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 120 })
  @IsString()
  @Length(
    ALBUM_TITLE_LENGTH.min,
    ALBUM_TITLE_LENGTH.max,
    withParams({ ...ALBUM_TITLE_LENGTH }),
  )
  titleEn: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 120 })
  @IsString()
  @Length(
    ALBUM_TITLE_LENGTH.min,
    ALBUM_TITLE_LENGTH.max,
    withParams({ ...ALBUM_TITLE_LENGTH }),
  )
  titleAr: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'The community event it is of.',
  })
  @IsOptional()
  @IsUUID('all')
  eventId?: string;
}

export class AddPhotoDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An uploaded file of purpose `gallery_photo`.',
  })
  @IsUUID('all')
  fileId: string;

  @ApiProperty({ type: String, required: false, minLength: 1, maxLength: 300 })
  @IsOptional()
  @IsString()
  @Length(
    CAPTION_LENGTH.min,
    CAPTION_LENGTH.max,
    withParams({ ...CAPTION_LENGTH }),
  )
  caption?: string;
}

export class GalleryReasonDto {
  @ApiProperty({
    type: String,
    description:
      'A code: `galleryPhotoReport` for a resident (privacy hides the photo at once), `galleryPhotoHide` for the staff.',
  })
  @IsString()
  reasonCode: string;
}
