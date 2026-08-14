import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

/** Client gọi hệ thống OMS (warehouse-be) ngoài — auth bằng API key tĩnh (x-api-key), không lưu dữ liệu về DB. */
@Injectable()
export class OmsApiService {
  private readonly logger = new Logger(OmsApiService.name);
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.http = axios.create({
      baseURL: (this.config.get<string>('OMS_API_URL') ?? '').trim(),
      timeout: 15_000,
      headers: {
        'x-api-key': (this.config.get<string>('OMS_API_KEY') ?? '').trim(),
        Accept: 'application/json',
      },
    });
  }

  isReady(): boolean {
    return Boolean(this.config.get<string>('OMS_API_URL') && this.config.get<string>('OMS_API_KEY'));
  }

  async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    try {
      const { data } = await this.http.get<T>(path, { params });
      return data;
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      this.logger.error(`OMS GET ${path} failed${status ? ` (${status})` : ''}: ${(err as Error).message}`);
      throw err;
    }
  }
}
