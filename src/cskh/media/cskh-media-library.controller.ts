import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CskhMediaLibraryService } from './cskh-media-library.service';

@Controller('cskh/media-library')
@UseGuards(JwtAuthGuard)
export class CskhMediaLibraryController {
  constructor(private readonly media: CskhMediaLibraryService) {}

  @Get('folders')
  listFolders() {
    return this.media.listFolders();
  }

  @Post('folders')
  createFolder(@Body() body: { name?: string }) {
    return this.media.createFolder(body.name ?? '');
  }

  @Delete('folders/:folderId')
  deleteFolder(@Param('folderId') folderId: string) {
    return this.media.deleteFolder(folderId);
  }

  @Get('assets')
  listAssets(@Query('folderId') folderId?: string) {
    return this.media.listAssets(folderId);
  }

  @Get('folders/:folderId/assets')
  listFolderAssets(@Param('folderId') folderId: string) {
    return this.media.listAssets(folderId);
  }

  @Post('folders/:folderId/assets')
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      storage: memoryStorage(),
      limits: { fileSize: 8 * 1024 * 1024 },
    }),
  )
  upload(
    @Param('folderId') folderId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ) {
    if (!files?.length) {
      throw new BadRequestException('Chọn ít nhất một ảnh');
    }
    return this.media.upload(folderId, files);
  }

  @Delete('assets/:assetId')
  deleteAsset(@Param('assetId') assetId: string) {
    return this.media.deleteAsset(assetId);
  }
}
