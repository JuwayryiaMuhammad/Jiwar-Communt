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
  @NoStore()
  @ApiCreatedResponse({ type: NewUploadView })
  async create(@Body() dto: NewUploadDto): Promise<NewUploadView> {
    const { file, upload } = await this.files.createUpload(dto);
    return { id: file.id, upload: UploadTargetView.from(upload) };
  }

  @Post(':id/finalize')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: FileView })
  async finalize(@Param('id', parseId()) id: string): Promise<FileView> {
    return FileView.from(await this.files.finalize(id));
  }

  @Get(':id')
  @NoStore()
  @ApiOkResponse({ type: FileReadView })
  async read(@Param('id', parseId()) id: string): Promise<FileReadView> {
    const { file, read } = await this.files.read(id);
    return FileReadView.fromRead(file, read);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async remove(@Param('id', parseId()) id: string): Promise<void> {
    await this.files.remove(id);
  }
}
