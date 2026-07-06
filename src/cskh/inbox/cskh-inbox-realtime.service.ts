import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageEvent } from '@nestjs/common';
import Redis from 'ioredis';
import {
  isRedisCircuitOpen,
  isRedisQuotaError,
  onRedisQuotaTripped,
} from '../redis/cskh-redis-circuit';
import { Observable, Subject } from 'rxjs';

export type InboxMessagePayload = {
  id: string;
  conversationId: string;
  fbMessageId: string | null;
  direction: string;
  senderType: string;
  text: string;
  messageType: string;
  attachmentUrl: string | null;
  sentAt: string;
  status: string;
};

export type InboxConversationPayload = {
  id: string;
  pageId: string;
  pageName: string | null;
  participantPsid: string;
  customerName: string | null;
  customerPictureUrl: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  awaitingLabel?: boolean;
  fromAd: boolean;
  adTitle: string | null;
  adId?: string | null;
  referralSource?: string | null;
  labels?: InboxLabelPayload[];
  labelsLocked?: boolean;
  viewers?: InboxViewerPayload[];
};

export type InboxViewerPayload = {
  userId: number;
  fullName: string;
  avatarUrl: string | null;
  viewedAt: string;
  hasChot?: boolean;
};

export type InboxLabelPayload = {
  id: string;
  name: string;
  color: string;
  type: 'staff' | 'status';
  userId: number | null;
  sortOrder: number;
};

export type CustomerInterestedProduct = {
  productId: number;
  variantId: number;
  name: string;
  variantTitle: string;
  price: number;
  priceLabel: string;
  compareAtPrice: number | null;
  sku: string | null;
  imageUrl: string | null;
  inStock: boolean;
  matchReason: string;
};

export type CustomerIntentPayload = {
  summary: string;
  intentLabel: string;
  topics: string[];
  urgency: 'low' | 'normal' | 'high';
  suggestedFocus: string;
  suggestedReply?: string;
  analyzedAt: string;
  productMentions?: string[];
  products?: CustomerInterestedProduct[];
  sapoConfigured?: boolean;
  isStale?: boolean;
};

export type InboxRealtimePayload = {
  type: 'conversation' | 'message' | 'intent' | 'typing' | 'read-receipt' | 'ping';
  pageId?: string;
  conversationId?: string;
  messages?: InboxMessagePayload[];
  conversation?: Partial<InboxConversationPayload> & { id: string };
  intent?: CustomerIntentPayload;
  tenantId?: string;
};

const REALTIME_CHANNEL = 'cskh:inbox:realtime';

@Injectable()
export class CskhInboxRealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CskhInboxRealtimeService.name);
  private readonly bus = new Subject<MessageEvent>();
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private redisEnabled = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const cleanValue = (val: unknown) => {
      if (typeof val !== 'string') return val;
      return val.trim().replace(/^['"]|['"]$/g, '');
    };

    const redisUrl = cleanValue(this.configService.get<string>('REDIS_URL'));
    const host = cleanValue(this.configService.get<string>('REDIS_HOST')) || 'localhost';
    const port = Number(this.configService.get<number>('REDIS_PORT')) || 6379;
    const password =
      cleanValue(
        this.configService.get<string>('REDIS_PASSWORD') ||
          this.configService.get<string>('REDISPASSWORD'),
      ) || undefined;

    try {
      if (redisUrl) {
        this.publisher = new Redis(redisUrl as string);
        this.subscriber = new Redis(redisUrl as string);
      } else {
        const cfg = { host: host as string, port, password: password as string | undefined };
        this.publisher = new Redis(cfg);
        this.subscriber = new Redis(cfg);
      }

      this.subscriber.on('message', (_channel, raw) => {
        try {
          const payload = JSON.parse(raw) as InboxRealtimePayload;
          this.bus.next({ data: payload });
        } catch (e) {
          this.logger.warn(`Invalid realtime payload: ${(e as Error).message}`);
        }
      });

      void this.subscriber.subscribe(REALTIME_CHANNEL).then(() => {
        this.redisEnabled = true;
        this.logger.log('Inbox realtime Redis pub/sub enabled');
      });
    } catch (e) {
      this.logger.warn(
        `Redis pub/sub unavailable — realtime chỉ local process: ${(e as Error).message}`,
      );
    }
  }

  async onModuleDestroy() {
    await Promise.all([
      this.publisher?.quit().catch(() => undefined),
      this.subscriber?.quit().catch(() => undefined),
    ]);
  }

  publish(payload: InboxRealtimePayload) {
    if (this.redisEnabled && this.publisher && !isRedisCircuitOpen()) {
      void this.publisher.publish(REALTIME_CHANNEL, JSON.stringify(payload)).catch((e) => {
        if (isRedisQuotaError(e)) onRedisQuotaTripped(this.logger);
        this.logger.warn(`Realtime Redis publish failed: ${(e as Error).message}`);
        this.bus.next({ data: payload });
      });
      return;
    }
    this.bus.next({ data: payload });
  }

  stream(): Observable<MessageEvent> {
    return this.bus.asObservable();
  }
}
