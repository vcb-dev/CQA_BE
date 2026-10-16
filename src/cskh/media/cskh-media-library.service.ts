import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { basename } from 'path';
import { PrismaService } from '../../prisma/prisma.service';

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export interface MediaFolderRow {
  id: string;
  name: string;
  createdAt: Date;
}

export interface MediaAssetRow {
  id: string;
  folderId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  thumbUrl: string;
  createdAt: Date;
}

@Injectable()
export class CskhMediaLibraryService {
  private readonly logger = new Logger(CskhMediaLibraryService.name);
  private configured = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  /**
   * Lấy danh sách các folder
   */
  async listFolders(): Promise<MediaFolderRow[]> {
    return this.prisma.cskhMediaFolder.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, createdAt: true },
    });
  }
  /**
   * Tạo mới một folder
   */
  async createFolder(name: string): Promise<MediaFolderRow> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 80) {
      throw new BadRequestException('Tên folder từ 1 đến 80 ký tự');
    }
    try {
      return await this.prisma.cskhMediaFolder.create({
        data: { name: trimmed },
        select: { id: true, name: true, createdAt: true },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Folder này đã có');
      }
      throw e;
    }
  }

  /**
   * Xóa một folder
   */
  async deleteFolder(folderId: string): Promise<{ deleted: true }> {
    const assets = await this.prisma.cskhMediaAsset.findMany({
      where: { folderId },
      select: { publicId: true },
    });
    await this.destroy(assets.map((asset) => asset.publicId));
    const result = await this.prisma.cskhMediaFolder.deleteMany({
      where: { id: folderId },
    });
    if (result.count === 0) {
      throw new NotFoundException('Không tìm thấy folder');
    }
    return { deleted: true };
  }

  /**
   * Lấy danh sách các ảnh
   */
  async listAssets(folderId?: string): Promise<MediaAssetRow[]> {
    const folder = folderId?.trim();
    if (folder) await this.assertFolder(folder);
    const rows = await this.prisma.cskhMediaAsset.findMany({
      where: folder ? { folderId: folder } : undefined,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        folderId: true,
        name: true,
        mimeType: true,
        sizeBytes: true,
        publicId: true,
        url: true,
        createdAt: true,
      },
    });
    return rows.map((row) => this.toRow(row));
  }

  /**
   * Tải lên một ảnh
   */
  async upload(
    folderId: string,
    files: Express.Multer.File[],
  ): Promise<MediaAssetRow[]> {
    await this.assertFolder(folderId);
    if (!files.length) throw new BadRequestException('Chọn ít nhất một ảnh');
    for (const file of files) this.assertImage(file);
    const created: MediaAssetRow[] = [];
    for (const file of files) {
      const uploaded = await this.uploadBuffer(
        file,
        `${this.rootFolder()}/media/${folderId}`,
      );
      try {
        const row = await this.prisma.cskhMediaAsset.create({
          data: {
            folderId,
            name: this.filenameOf(file),
            mimeType: file.mimetype,
            sizeBytes: file.size,
            publicId: uploaded.public_id,
            url: uploaded.secure_url,
          },
          select: {
            id: true,
            folderId: true,
            name: true,
            mimeType: true,
            sizeBytes: true,
            publicId: true,
            url: true,
            createdAt: true,
          },
        });
        created.push(this.toRow(row));
      } catch (e) {
        await this.destroy([uploaded.public_id]);
        throw e;
      }
    }
    return created;
  }

  /**
   * Xóa một ảnh
   */
  async deleteAsset(assetId: string): Promise<{ deleted: true }> {
    const row = await this.prisma.cskhMediaAsset.findFirst({
      where: { id: assetId },
      select: { publicId: true },
    });
    if (!row) throw new NotFoundException('Không tìm thấy ảnh');
    await this.destroy([row.publicId]);
    await this.prisma.cskhMediaAsset.delete({ where: { id: assetId } });
    return { deleted: true };
  }

  /**
   * Chuyển đổi dữ liệu từ database sang dữ liệu hiển thị
   */
  private toRow(row: {
    id: string;
    folderId: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    publicId: string;
    url: string;
    createdAt: Date;
  }): MediaAssetRow {
    // Lấy tên cloud
    const cloud = this.config.get<string>('CLOUDINARY_CLOUD_NAME') ?? '';
    // Trả về dữ liệu ảnh
    return {
      id: row.id,
      folderId: row.folderId,
      name: row.name,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      url: row.url,
      thumbUrl: `https://res.cloudinary.com/${cloud}/image/upload/c_fill,w_160,h_160,q_auto,f_auto/${row.publicId}`,
      createdAt: row.createdAt,
    };
  }

  /**
   * Lấy thư mục gốc
   */
  private rootFolder(): string {
    return (this.config.get<string>('CLOUDINARY_FOLDER') || 'CQA').replace(
      /^\/+|\/+$/g,
      '',
    );
  }

  /**
   * Kiểm tra cấu hình Cloudinary
   */
  private ensureConfig(): void {
    if (this.configured) return;
    const cloud_name = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const api_key = this.config.get<string>('CLOUDINARY_API_KEY');
    const api_secret = this.config.get<string>('CLOUDINARY_API_SECRET');
    if (!cloud_name || !api_key || !api_secret) {
      throw new BadRequestException('Chưa cấu hình Cloudinary');
    }
    cloudinary.config({ cloud_name, api_key, api_secret });
    this.configured = true;
  }

  /**
   * Tải lên một ảnh
   */
  private uploadBuffer(
    file: Express.Multer.File,
    folder: string,
  ): Promise<UploadApiResponse> {
    this.ensureConfig();
    // Tải lên ảnh
    return new Promise((resolve, reject) => {
      // Tạo stream
      const stream = cloudinary.uploader.upload_stream(
        { folder, resource_type: 'image' },
        (error, result) => {
          if (error || !result) {
            this.logger.error(`Cloudinary upload failed: ${error?.message}`);
            reject(
              new BadRequestException('Không tải được ảnh lên Cloudinary'),
            );
            return;
          }
          // Trả về kết quả
          resolve(result);
        },
      );
      // Kết thúc stream
      stream.end(file.buffer);
    });
  }

  /**
   * Xóa một ảnh
   */
  private async destroy(publicIds: string[]): Promise<void> {
    if (!publicIds.length) return; // Nếu không có ảnh
    this.ensureConfig();
    try {
      // Xóa ảnh trên Cloudinary
      await cloudinary.api.delete_resources(publicIds, {
        resource_type: 'image',
      });
    } catch (e) {
      // Nếu có lỗi
      this.logger.error(
        `Cloudinary delete failed: ${e instanceof Error ? e.message : e}`,
      );
      throw new BadRequestException('Không xóa được ảnh trên Cloudinary');
    }
  }

  /**
   * Kiểm tra folder
   */
  private async assertFolder(folderId: string): Promise<void> {
    const folder = await this.prisma.cskhMediaFolder.findFirst({
      where: { id: folderId },
      select: { id: true },
    });
    if (!folder) throw new NotFoundException('Không tìm thấy folder');
  }

  /**
   * Kiểm tra ảnh
   */
  private assertImage(file: Express.Multer.File): void {
    if (!file.buffer?.length) throw new BadRequestException('File rỗng'); // Nếu file rỗng
    if (!ALLOWED.has(file.mimetype)) {
      // Nếu không phải ảnh
      throw new BadRequestException('Chỉ nhận ảnh JPEG, PNG, WebP, GIF');
    }
    if (file.size > MAX_BYTES) {
      // Nếu ảnh lớn hơn 8MB
      throw new BadRequestException('Ảnh tối đa 8MB');
    }
  }
  /**
   * Lấy tên ảnh
   */
  private filenameOf(file: Express.Multer.File): string {
    const raw = basename(file.originalname || 'image');
    // Busboy đưa tên UTF-8 dưới dạng chuỗi Latin-1
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    // Nếu có ký tự \uFFFD thì lấy tên gốc
    const name = decoded.includes('\uFFFD') ? raw : decoded;
    // Trả về tên ảnh
    return name.slice(0, 200);
  }
}
