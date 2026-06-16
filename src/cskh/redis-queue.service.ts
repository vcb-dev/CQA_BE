import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { CskhInboxService } from './cskh-inbox.service';

@Injectable()
export class RedisQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisQueueService.name);
  private redisClient: Redis;
  private webhookConsumer: Redis;
  private intentConsumer: Redis;
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => CskhInboxService))
    private readonly inboxService: CskhInboxService,
  ) {}

  onModuleInit() {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    const host = this.configService.get<string>('REDIS_HOST') || 'localhost';
    const port = Number(this.configService.get<number>('REDIS_PORT')) || 6379;
    const password = this.configService.get<string>('REDIS_PASSWORD') || this.configService.get<string>('REDISPASSWORD') || undefined;

    if (redisUrl) {
      this.logger.log('Initializing Redis connections using REDIS_URL...');
      this.redisClient = new Redis(redisUrl);
      this.webhookConsumer = new Redis(redisUrl);
      this.intentConsumer = new Redis(redisUrl);
    } else {
      this.logger.log(`Initializing Redis connections to ${host}:${port}...`);
      const redisConfig = { host, port, password };
      this.redisClient = new Redis(redisConfig);
      this.webhookConsumer = new Redis(redisConfig);
      this.intentConsumer = new Redis(redisConfig);
    }

    this.running = true;

    // Start background worker loops
    void this.runWebhookWorker();
    void this.runIntentWorker();
  }

  async onModuleDestroy() {
    this.running = false;
    this.logger.log('Closing Redis connections...');
    await Promise.all([
      this.redisClient.quit(),
      this.webhookConsumer.quit(),
      this.intentConsumer.quit(),
    ]).catch((e) => {
      this.logger.warn(`Error closing Redis connections: ${e.message}`);
    });
  }

  // Regular Redis Client for Cache operations
  get client(): Redis {
    return this.redisClient;
  }

  // Webhook Queue
  async enqueueWebhook(pageId: string, event: any): Promise<void> {
    try {
      const payload = JSON.stringify({ pageId, event });
      await this.redisClient.lpush('cskh:webhook_queue', payload);
    } catch (e) {
      this.logger.error(`Failed to enqueue webhook: ${e.message}`, e.stack);
      // Fallback: process synchronously if Redis fails to ensure no lost messages
      void this.inboxService.ingestMessagingEvent(pageId, event).catch((err) => {
        this.logger.error(`Fallback synchronous webhook processing failed: ${err.message}`, err.stack);
      });
    }
  }

  private async runWebhookWorker() {
    this.logger.log('Webhook Worker started.');
    while (this.running) {
      try {
        // BRPOP blocks connection, returns [key, value] or null if timeout (we use 5s timeout)
        const result = await this.webhookConsumer.brpop('cskh:webhook_queue', 5);
        if (!result) continue;

        const [, value] = result;
        const { pageId, event } = JSON.parse(value);

        await this.inboxService.ingestMessagingEvent(pageId, event);
      } catch (e) {
        this.logger.error(`Error in Webhook Worker: ${e.message}`, e.stack);
        await new Promise((r) => setTimeout(r, 1000)); // Sleep 1s on error to prevent CPU thrashing
      }
    }
    this.logger.log('Webhook Worker stopped.');
  }

  // Intent Queue
  async enqueueIntent(conversationId: string, tenantId?: string): Promise<void> {
    try {
      const payload = JSON.stringify({ conversationId, tenantId });
      await this.redisClient.lpush('cskh:intent_queue', payload);
    } catch (e) {
      this.logger.error(`Failed to enqueue intent: ${e.message}`, e.stack);
      // Fallback: process asynchronously in background if Redis fails
      void this.inboxService.analyzeAndBroadcastIntent(conversationId, tenantId).catch((err) => {
        this.logger.error(`Fallback intent processing failed: ${err.message}`, err.stack);
      });
    }
  }

  private async runIntentWorker() {
    this.logger.log('Intent Worker started.');
    while (this.running) {
      try {
        const result = await this.intentConsumer.brpop('cskh:intent_queue', 5);
        if (!result) continue;

        const [, value] = result;
        const { conversationId, tenantId } = JSON.parse(value);

        await this.inboxService.analyzeAndBroadcastIntent(conversationId, tenantId);
      } catch (e) {
        this.logger.error(`Error in Intent Worker: ${e.message}`, e.stack);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    this.logger.log('Intent Worker stopped.');
  }

  // Intent Cache Helpers
  async getIntentCache(key: string): Promise<any> {
    try {
      const cached = await this.redisClient.get(`cskh:intent_cache:${key}`);
      return cached ? JSON.parse(cached) : null;
    } catch (e) {
      this.logger.warn(`Failed to get intent cache from Redis: ${e.message}`);
      return null;
    }
  }

  async setIntentCache(key: string, data: any, ttlSeconds = 120): Promise<void> {
    try {
      await this.redisClient.set(
        `cskh:intent_cache:${key}`,
        JSON.stringify(data),
        'EX',
        ttlSeconds,
      );
    } catch (e) {
      this.logger.warn(`Failed to set intent cache in Redis: ${e.message}`);
    }
  }
}
