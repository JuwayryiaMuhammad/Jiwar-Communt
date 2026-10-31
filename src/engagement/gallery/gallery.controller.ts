import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  AddPhotoDto,
  CreateAlbumDto,
  GalleryReasonDto,
} from './dto/gallery.dto';
import {
  GalleryService,
  type AlbumRead,
  type PhotoRead,
} from './gallery.service';

export class GalleryPhotoView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  caption: string | null;
  @ApiProperty({ type: String })
  contentType: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A presigned GET, valid until `expiresAt`.',
  })
  url: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt: Date | null;

  static from(p: PhotoRead): GalleryPhotoView {
    return {
      id: p.photo.id,
      caption: p.photo.caption,
      contentType: p.contentType,
      url: p.read?.url ?? null,
      expiresAt: p.read?.expiresAt ?? null,
    };
  }
}

export class StaffGalleryPhotoView extends GalleryPhotoView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: '`privacy_report`, or a `galleryPhotoHide` code.',
  })
  hiddenReason: string | null;
  @ApiProperty({ type: Number })
  reports: number;

  static fromStaff(p: PhotoRead): StaffGalleryPhotoView {
    return {
      ...GalleryPhotoView.from(p),
      hiddenReason: p.photo.hiddenReason,
      reports: p.reports,
    };
  }
}

export class GalleryAlbumView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  titleEn: string;
  @ApiProperty({ type: String })
  titleAr: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  eventId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  publishedAt: Date | null;
  @ApiProperty({ type: [GalleryPhotoView], description: 'Its visible photos.' })
  photos: GalleryPhotoView[];

  static from(r: AlbumRead): GalleryAlbumView {
    return {
      id: r.album.id,
      titleEn: r.album.titleEn,
      titleAr: r.album.titleAr,
      eventId: r.album.eventId,
      publishedAt: r.album.publishedAt,
      photos: r.photos.map((p) => GalleryPhotoView.from(p)),
    };
  }
}

export class StaffGalleryAlbumView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  titleEn: string;
  @ApiProperty({ type: String })
  titleAr: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  eventId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  publishedAt: Date | null;
  @ApiProperty({
    type: [StaffGalleryPhotoView],
    description: 'Every photo, hidden ones too.',
  })
  photos: StaffGalleryPhotoView[];

  static from(r: AlbumRead): StaffGalleryAlbumView {
    return {
      id: r.album.id,
      titleEn: r.album.titleEn,
      titleAr: r.album.titleAr,
      eventId: r.album.eventId,
      publishedAt: r.album.publishedAt,
      photos: r.photos.map((p) => StaffGalleryPhotoView.fromStaff(p)),
    };
  }
}

/** The gallery, for residents (ADR 0071). */
@ApiArea('community')
@RequirePermissions('community.read')
@Controller('gallery')
export class GalleryController {
  constructor(private readonly gallery: GalleryService) {}

  @Get('albums')
  @NoStore()
  @ApiOperation({ summary: 'List the published albums' })
  @ApiOkResponse({ type: ListOf(GalleryAlbumView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<GalleryAlbumView>> {
    return toList(await this.gallery.list(q), (r) => GalleryAlbumView.from(r));
  }

  @Get('albums/:id')
  @NoStore()
  @ApiOperation({ summary: 'Get a published album' })
  @ApiOkResponse({ type: GalleryAlbumView })
  async get(@Param('id', parseId()) id: string): Promise<GalleryAlbumView> {
    return GalleryAlbumView.from(await this.gallery.get(id));
  }

  /** Privacy hides it at once, pending the staff. */
  @Post('photos/:id/report')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Report a photo' })
  @ApiNoContentResponse()
  async report(
    @Param('id', parseId()) id: string,
    @Body() dto: GalleryReasonDto,
  ): Promise<void> {
    await this.gallery.report(id, dto.reasonCode);
  }
}

/** The staff keep the gallery (ADR 0071). */
@ApiArea('community')
@RequirePermissions('content.manage')
@Controller('community/gallery')
export class StaffGalleryController {
  constructor(private readonly gallery: GalleryService) {}

  @Get('albums')
  @NoStore()
  @ApiOperation({ summary: 'List every album, drafts too' })
  @ApiOkResponse({ type: ListOf(StaffGalleryAlbumView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<StaffGalleryAlbumView>> {
    return toList(await this.gallery.staffList(q), (r) =>
      StaffGalleryAlbumView.from(r),
    );
  }

  @Post('albums')
  @NoStore()
  @ApiOperation({ summary: 'Start an album' })
  @ApiCreatedResponse({ type: StaffGalleryAlbumView })
  async create(@Body() dto: CreateAlbumDto): Promise<StaffGalleryAlbumView> {
    return StaffGalleryAlbumView.from(await this.gallery.createAlbum(dto));
  }

  @Post('albums/:id/photos')
  @NoStore()
  @ApiOperation({ summary: 'Add a photo to an album' })
  @ApiCreatedResponse({ type: StaffGalleryPhotoView })
  async add(
    @Param('id', parseId()) id: string,
    @Body() dto: AddPhotoDto,
  ): Promise<StaffGalleryPhotoView> {
    return StaffGalleryPhotoView.fromStaff(
      await this.gallery.addPhoto(id, dto),
    );
  }

  @Post('albums/:id/publish')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Publish an album' })
  @ApiNoContentResponse()
  async publish(@Param('id', parseId()) id: string): Promise<void> {
    await this.gallery.publish(id);
  }

  @Post('photos/:id/hide')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Hide a photo, or keep a reported one hidden' })
  @ApiNoContentResponse()
  async hide(
    @Param('id', parseId()) id: string,
    @Body() dto: GalleryReasonDto,
  ): Promise<void> {
    await this.gallery.hide(id, dto.reasonCode);
  }

  @Post('photos/:id/restore')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Show a hidden photo again' })
  @ApiNoContentResponse()
  async restore(@Param('id', parseId()) id: string): Promise<void> {
    await this.gallery.restore(id);
  }
}
