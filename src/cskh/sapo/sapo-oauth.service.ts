import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  buildSapoAuthorizeUrl,
  exchangeSapoAccessToken,
  normalizeSapoStoreHost,
  SAPO_DEFAULT_SCOPES,
} from './sapo-oauth.util';

@Injectable()
export class SapoOAuthService {
  private readonly logger = new Logger(SapoOAuthService.name);

  constructor(private readonly config: ConfigService) {}

  /** Redirect URI phải trùng Callback URL trên Partner App. */
  getRedirectUri(): string {
    const explicit = (this.config.get<string>('SAPO_OAUTH_REDIRECT_URI') ?? '').trim();
    if (explicit) return explicit;
    const base = (this.config.get<string>('PUBLIC_BE_URL') ?? '').trim().replace(/\/$/, '');
    if (!base) {
      throw new BadRequestException('Thiếu PUBLIC_BE_URL hoặc SAPO_OAUTH_REDIRECT_URI');
    }
    return `${base}/cskh/sapo/oauth/callback`;
  }

  getOAuthStartUrl(): string {
    const store = this.requireStore();
    const clientId = this.requireClientId();
    return buildSapoAuthorizeUrl({
      store,
      clientId,
      redirectUri: this.getRedirectUri(),
      scopes: (this.config.get<string>('SAPO_OAUTH_SCOPES') ?? SAPO_DEFAULT_SCOPES).trim(),
    });
  }

  async exchangeCode(code: string): Promise<{ accessToken: string; sampleProductTitle: string | null }> {
    if (!code?.trim()) {
      throw new BadRequestException('Thiếu authorization code');
    }

    const accessToken = await exchangeSapoAccessToken({
      store: this.requireStore(),
      clientId: this.requireClientId(),
      clientSecret: this.requireClientSecret(),
      code: code.trim(),
    });

    const sampleProductTitle = await this.fetchSampleProductTitle(accessToken);
    this.logger.log(
      `Sapo OAuth OK — store=${this.requireStore()} sample=${sampleProductTitle ?? 'none'}`,
    );

    return { accessToken, sampleProductTitle };
  }

  isOAuthConfigured(): boolean {
    return Boolean(
      (this.config.get<string>('SAPO_STORE') ?? '').trim() &&
        (this.config.get<string>('SAPO_API_KEY') ?? '').trim() &&
        (this.config.get<string>('SAPO_API_SECRET') ?? '').trim(),
    );
  }

  private requireStore(): string {
    const store = (this.config.get<string>('SAPO_STORE') ?? '').trim();
    if (!store) throw new BadRequestException('Thiếu SAPO_STORE (ví dụ: vienchibao)');
    return store;
  }

  private requireClientId(): string {
    const id = (this.config.get<string>('SAPO_API_KEY') ?? '').trim();
    if (!id) throw new BadRequestException('Thiếu SAPO_API_KEY (API Key trên Partner App)');
    return id;
  }

  private requireClientSecret(): string {
    const secret = (this.config.get<string>('SAPO_API_SECRET') ?? '').trim();
    if (!secret) throw new BadRequestException('Thiếu SAPO_API_SECRET (Secret Key trên Partner App)');
    return secret;
  }

  private async fetchSampleProductTitle(accessToken: string): Promise<string | null> {
    const host = normalizeSapoStoreHost(this.requireStore());
    try {
      const { data } = await axios.get<{ products?: Array<{ title?: string }> }>(
        `https://${host}/admin/products.json`,
        {
          headers: { 'X-Sapo-Access-Token': accessToken },
          params: { limit: 1 },
          timeout: 20_000,
        },
      );
      return data.products?.[0]?.title?.trim() ?? null;
    } catch {
      return null;
    }
  }
}
