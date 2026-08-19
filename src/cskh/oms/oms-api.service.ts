import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export function omsErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as
      | { error?: { message?: string }; message?: string }
      | string
      | undefined;
    if (typeof data === 'string' && data.trim()) return data.trim();
    if (data && typeof data === 'object') {
      if (typeof data.error?.message === 'string' && data.error.message) return data.error.message;
      if (typeof data.message === 'string' && data.message) return data.message;
    }
    if (err.response?.status === 401 || err.response?.status === 403) {
      return 'Warehouse từ chối API key — kiểm tra OMS_API_KEY.';
    }
  }
  return err instanceof Error ? err.message : 'Không gọi được hệ thống kho';
}

/** Client gọi hệ thống OMS (warehouse-be) ngoài — auth bằng API key tĩnh (x-api-key), không lưu dữ liệu về DB. */
@Injectable()
export class OmsApiService {
  private readonly logger = new Logger(OmsApiService.name);
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.http = axios.create({
      baseURL: (this.config.get<string>('OMS_API_URL') ?? '').trim(),
      timeout: 20_000,
      headers: {
        'x-api-key': (this.config.get<string>('OMS_API_KEY') ?? '').trim(),
        Accept: 'application/json',
      },
    });
  }

  isReady(): boolean {
    return Boolean(this.config.get<string>('OMS_API_URL') && this.config.get<string>('OMS_API_KEY'));
  }

  assertReady() {
    if (!this.isReady()) {
      throw new ServiceUnavailableException(
        'Chưa cấu hình OMS_API_URL / OMS_API_KEY — không gửi được đơn sang kho.',
      );
    }
  }

  async get<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    try {
      const { data } = await this.http.get<T>(path, { params });
      return data;
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      this.logger.error(`OMS GET ${path} failed${status ? ` (${status})` : ''}: ${omsErrorMessage(err)}`);
      throw this.wrap(err);
    }
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    try {
      const { data } = await this.http.post<T>(path, body);
      return data;
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      this.logger.error(`OMS POST ${path} failed${status ? ` (${status})` : ''}: ${omsErrorMessage(err)}`);
      throw this.wrap(err);
    }
  }

  private wrap(err: unknown): Error {
    const msg = omsErrorMessage(err);
    if (axios.isAxiosError(err) && (err.response?.status === 401 || err.response?.status === 403)) {
      return new ServiceUnavailableException(msg);
    }
    return new BadRequestException(msg);
  }
}
