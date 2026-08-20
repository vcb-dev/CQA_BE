import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageEvent } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  isRedisCircuitOpen,
  isRedisQuotaError,
  onRedisQuotaTripped,
} from '../redis/cskh-redis-circuit';
import {
  connectCskhRedis,
  createCskhRedisClient,
  isRedisDisabledByEnv,
  resolveRedisConnectionConfig,
} from '../redis/cskh-redis-client';
import { Observable, Subject } from 'rxjs';
import { inboxRtLog, inboxRtWarn } from './inbox-realtime-debug.util';

export type InboxMessagePayload = {
  id: string;
  conversationId: string;
  fbMessageId: string | null;
  direction: string;
  senderType: string;
  text: string;
  originalText?: string | null;
  translatedText?: string | null;
  sourceLang?: string | null;
  messageType: string;
  attachmentUrl: string | null;
  attachmentUrls?: string[];
  groupedMediaCount?: number;
  sentAt: string;
  status: string;
};

export type InboxConversationPayload = {
  id: string;
  pageId: string;
  pageName: string | null;
  fbConversationId?: string | null;
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
  customerLang?: string | null;
  customerLangLabel?: string | null;
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
  /** Tránh duplicate SSE khi vừa emit local vừa nhận echo từ Redis subscriber. */
  private readonly recentLocalEmitAt = new Map<string, number>();

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    if (isRedisDisabledByEnv()) {
      this.logger.warn('CSKH_REDIS_ENABLED=false — realtime chỉ local process');
      return;
    }

    const cfg = resolveRedisConnectionConfig(this.configService);
    try {
      this.publisher = createCskhRedisClient(cfg, {
        logger: this.logger,
        label: 'realtime-pub',
      });
      this.subscriber = createCskhRedisClient(cfg, {
        logger: this.logger,
        label: 'realtime-sub',
      });

      const pubOk = await connectCskhRedis(this.publisher, {
        logger: this.logger,
        label: 'realtime-pub',
      });
      const subOk = await connectCskhRedis(this.subscriber, {
        logger: this.logger,
        label: 'realtime-sub',
      });

      if (!pubOk || !subOk) {
        this.publisher = null;
        this.subscriber = null;
        this.logger.warn(
          'Redis pub/sub unavailable — realtime chỉ local process (Upstash quota hoặc lỗi kết nối)',
        );
        return;
      }

      const subscriber = this.subscriber;
      const publisher = this.publisher;
      if (!subscriber || !publisher) return;

      subscriber.on('message', (_channel, raw) => {
        try {
          const payload = JSON.parse(raw) as InboxRealtimePayload;
          this.emit(payload, 'redis');
        } catch (e) {
          this.logger.warn(`Invalid realtime payload: ${(e as Error).message}`);
        }
      });

      await subscriber.subscribe(REALTIME_CHANNEL);
      this.redisEnabled = true;
      this.logger.log('Inbox realtime Redis pub/sub enabled');
      inboxRtLog('Redis pub/sub ready', { channel: REALTIME_CHANNEL });
    } catch (e) {
      if (isRedisQuotaError(e)) onRedisQuotaTripped(this.logger);
      this.publisher = null;
      this.subscriber = null;
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

  private dedupeKey(payload: InboxRealtimePayload): string {
    const msgId = payload.messages?.[0]?.id;
    if (msgId) return `msg:${msgId}`;
    if (payload.conversationId) {
      return `${payload.type ?? 'event'}:${payload.conversationId}:${payload.conversation?.lastMessageAt ?? ''}`;
    }
    return `${payload.type ?? 'event'}:${Date.now()}`;
  }

  private pruneRecentEmitKeys(now: number) {
    if (this.recentLocalEmitAt.size < 400) return;
    for (const [key, at] of this.recentLocalEmitAt) {
      if (now - at > 10_000) this.recentLocalEmitAt.delete(key);
    }
  }

  private emit(payload: InboxRealtimePayload, source: 'local' | 'redis') {
    const key = this.dedupeKey(payload);
    const now = Date.now();
    if (source === 'redis') {
      const localAt = this.recentLocalEmitAt.get(key);
      if (localAt != null && now - localAt < 5000) {
        inboxRtLog('emit skip duplicate (redis echo)', {
          type: payload.type,
          conversationId: payload.conversationId,
          dedupeKey: key,
          echoLagMs: now - localAt,
        });
        return;
      }
    } else {
      this.recentLocalEmitAt.set(key, now);
      this.pruneRecentEmitKeys(now);
    }
    const lastMsg = payload.messages?.[payload.messages.length - 1];
    inboxRtLog(`emit → SSE bus (${source})`, {
      type: payload.type,
      conversationId: payload.conversationId,
      pageId: payload.pageId,
      tenantId: payload.tenantId ?? null,
      messagePreview: lastMsg?.text?.slice(0, 80),
      messageSentAt: lastMsg?.sentAt,
      lastMessageAt: payload.conversation?.lastMessageAt,
      redisEnabled: this.redisEnabled,
    });
    this.bus.next({ data: payload });
  }

  publish(payload: InboxRealtimePayload) {
    const publishStartedAt = Date.now();
    // Luôn push SSE trên process hiện tại — không phụ thuộc 100% Redis subscriber echo.
    this.emit(payload, 'local');
    if (this.redisEnabled && this.publisher && !isRedisCircuitOpen()) {
      void this.publisher
        .publish(REALTIME_CHANNEL, JSON.stringify(payload))
        .then((subscriberCount) => {
          inboxRtLog('Redis publish ok', {
            type: payload.type,
            conversationId: payload.conversationId,
            subscribers: subscriberCount,
            tookMs: Date.now() - publishStartedAt,
          });
        })
        .catch((e) => {
          if (isRedisQuotaError(e)) onRedisQuotaTripped(this.logger);
          inboxRtWarn('Redis publish failed', {
            type: payload.type,
            conversationId: payload.conversationId,
            error: (e as Error).message,
          });
        });
    } else {
      inboxRtLog('Redis publish skipped', {
        type: payload.type,
        conversationId: payload.conversationId,
        redisEnabled: this.redisEnabled,
        circuitOpen: isRedisCircuitOpen(),
      });
    }
  }

  stream(): Observable<MessageEvent> {
    return this.bus.asObservable();
  }
}
