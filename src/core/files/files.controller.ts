import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequireAnyPermission } from '../access/require-permissions.decorator';
import { ApiArea, NoStore } from '../common/http/decorators';
import { parseId } from '../common/validation/parse-id.pipe';
import { NewUploadDto } from './dto/files.dto';
import { FilesService } from './files.service';
import { ANY_UPLOADER } from './purposes';
import {
  FileReadView,
  FileView,
  NewUploadView,
  UploadTargetView,
} from './views/file.views';

/**
 * The caller's own uploads (ADR 0029): declare, PUT to the presigned URL,
 * finalize. Open to any account that may upload some purpose; the purpose's
 * own permission is checked by the service. Features return their files'
 * URLs in their own views, under their own rules.
 */
@ApiArea('files')
@RequireAnyPermission(...ANY_UPLOADER)
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('uploads')
  @ApiOperation({ summary: 'Declare an upload and get a presigned PUT URL' })
  @NoStore()
  @ApiCreatedResponse({ type: NewUploadView })
  async create(@Body() dto: NewUploadDto): Promise<NewUploadView> {
    const { file, upload } = await this.files.createUpload(dto);
    return { id: file.id, upload: UploadTargetView.from(upload) };
  }

  @Post(':id/finalize')
  @ApiOperation({
    summary: 'Finalize an upload once the file is PUT',
    description:
      'The object must be exactly what was declared (422 FILE_CONTENT_MISMATCH; the file is deleted). A recording (ADR 0056) has its length read from its MP4 container, `moov` at the start or the end: a container that cannot be read is 422 FILE_MEDIA_UNREADABLE (params.reason), one with no movie header 422 FILE_MEDIA_NO_DURATION; the file is deleted either way.',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: FileView })
  async finalize(@Param('id', parseId()) id: string): Promise<FileView> {
    return FileView.from(await this.files.finalize(id));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of my uploads with a short-lived URL' })
  @NoStore()
  @ApiOkResponse({ type: FileReadView })
  async read(@Param('id', parseId()) id: string): Promise<FileReadView> {
    const { file, read } = await this.files.read(id);
    return FileReadView.fromRead(file, read);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete one of my uploads' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async remove(@Param('id', parseId()) id: string): Promise<void> {
    await this.files.remove(id);
  }
}
