import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  auditMatchesActivityFilter,
  resolveAuditActivityYmdRange,
} from './audit/audit-analytics.util';
import { FacebookGraphService } from './facebook/facebook-graph.service';
import { isPrismaRetryableDbError } from './inbox/cskh-inbox-conversation.util';
import {
  buildInboxSyntheticAuditRow,
} from './insight/inbox-insight.util';
import {
  buildProductSearchIndex,
  buildProductVideoTopic,
} from './insight/insight-product-match.util';
import { SapoProductService } from './sapo/sapo-product.service';

const CONCERN_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899'];

type AuditRow = {
  score: number;
  metadata: Record<string, unknown> | null;
};

type AuditFetchRow = AuditRow & {
  id: string;
  transcript: unknown;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

function normKey(s: string): string {
  return s.trim().toLowerCase();
}

function bumpMap(map: Map<string, number>, key: string, n = 1) {
  const k = normKey(key);
  if (!k) return;
  map.set(k, (map.get(k) ?? 0) + n);
}

function bumpProductMap(
  counts: Map<string, number>,
  labels: Map<string, string>,
  name: string,
  n = 1,
) {
  const display = name.trim();
  if (!display) return;
  const k = normKey(display);
  labels.set(k, display);
  counts.set(k, (counts.get(k) ?? 0) + n);
}

function productLabel(labels: Map<string, string>, key: string): string {
  return labels.get(key) ?? key;
}

function topEntries(map: Map<string, number>, limit: number, labelFn?: (k: string) => string) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({
      key,
      label: labelFn ? labelFn(key) : key,
      count,
    }));
}

function pctChange(current: number, previous: number): { text: string; positive: boolean } {
  if (previous <= 0) {
    return current > 0
      ? { text: `↑ ${current} mới`, positive: true }
      : { text: '—', positive: true };
  }
  const delta = ((current - previous) / previous) * 100;
  const rounded = Math.round(Math.abs(delta));
  if (Math.abs(delta) < 0.5) return { text: '→ 0%', positive: true };
  return delta >= 0
    ? { text: `↑ ${rounded}%`, positive: true }
    : { text: `↓ ${rounded}%`, positive: false };
}

function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function formatVnDate(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

function closingScore(meta: Record<string, unknown> | null): number | null {
  const cs = asRecord(meta?.criteriaScores);
  const v = cs?.closing;
  return typeof v === 'number' ? v : null;
}

function sentimentTone(meta: Record<string, unknown> | null): string {
  const s = asRecord(meta?.sentiment);
  const tone = s?.tone;
  return typeof tone === 'string' ? tone : 'unknown';
}

function intentLabel(meta: Record<string, unknown> | null): string {
  const ci = asRecord(meta?.customerIntent);
  const label = ci?.intentLabel;
  return typeof label === 'string' ? label : '';
}

/** Bỏ câu audit kiểu "không có ưu điểm..." — không phải yếu tố chốt thật. */
function isActionableStrength(text: string): boolean {
  const t = normKey(text);
  if (!t || t.length < 10) return false;
  if (/kh[oô]ng c[oó] (ưu đi[ểe]m|đi[ểe]m mạnh)/.test(t)) return false;
  if (/chưa có (ưu đi[ểe]m|phản hồi)/.test(t)) return false;
  if (/kh[oô]ng có gì nổi bật/.test(t)) return false;
  return true;
}

function isActionableWeakness(text: string): boolean {
  const t = normKey(text);
  return Boolean(t && t.length >= 10);
}

type PageBucket = {
  pageId: string;
  pageName: string;
  rows: AuditRow[];
};

type PageAgg = ReturnType<CskhInsightService['aggregate']>;

type PageInsightRow = {
  pageId: string;
  pageName: string;
  auditCount: number;
  audited: boolean;
  avgScore: number | null;
  passRate: number | null;
  riskRate: number | null;
  positiveRate: number | null;
  scoreChange: number | null;
  status: 'good' | 'warning' | 'critical' | 'pending';
  statusLabel: string;
  topIssue: string | null;
  topKeyword: string | null;
};

function pageStatus(avgScore: number, riskRate: number): 'good' | 'warning' | 'critical' {
  if (avgScore < 55 || riskRate >= 55) return 'critical';
  if (avgScore < 65 || riskRate >= 35) return 'warning';
  return 'good';
}

function statusLabel(status: PageInsightRow['status']): string {
  if (status === 'pending') return 'Chưa audit';
  if (status === 'good') return 'Ổn định';
  if (status === 'warning') return 'Cần cải thiện';
  return 'Cần xử lý gấp';
}

type PageAuditStat = {
  auditCount: number;
  avgScore: number;
  passRate: number;
  riskRate: number;
  positiveRate: number;
};

type PageOverviewRow = {
  pageId: string;
  pageName: string;
  convCount: number;
  fromAdCount: number;
};

@Injectable()
export class CskhInsightService {
  private readonly logger = new Logger(CskhInsightService.name);
  private readonly dashboardCache = new Map<string, { at: number; data: Awaited<ReturnType<CskhInsightService['getDashboard']>> }>();
  /** Cache dài hơn để giảm tải DB khi user đổi kênh / refresh — tránh đụng pool với inbox sync. */
  private readonly dashboardCacheTtlMs = Number(process.env.CSKH_INSIGHT_CACHE_MS || 180_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: FacebookGraphService,
    private readonly sapoProducts: SapoProductService,
  ) {}

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private validateRange(from: string, to: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new BadRequestException('Ngày không hợp lệ (YYYY-MM-DD)');
    }
    if (from > to) throw new BadRequestException('auditDateFrom phải ≤ auditDateTo');
  }

  private async fetchAudits(from: string, to: string, tenantId?: string): Promise<AuditRow[]> {
    const maxAttempts = 4;
    let rows: AuditFetchRow[] | null = null;
    let lastPoolError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        rows = await this.prisma.$queryRaw<AuditFetchRow[]>`
      SELECT id, score, metadata,
        CASE
          WHEN NULLIF(metadata->>'activityDateFrom', '') IS NOT NULL THEN NULL
          ELSE transcript
        END AS transcript
      FROM chat_audits
      WHERE (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
        AND transcript IS NOT NULL
        AND (
          (
            NULLIF(metadata->>'activityDateFrom', '') IS NOT NULL
            AND NULLIF(metadata->>'activityDateFrom', '') <= ${to}
            AND COALESCE(NULLIF(metadata->>'activityDateTo', ''), metadata->>'activityDateFrom') >= ${from}
          )
          OR (
            NULLIF(metadata->>'activityDateFrom', '') IS NULL
            AND NULLIF(metadata->>'auditDateFrom', '') IS NOT NULL
            AND metadata->>'auditDateFrom' <= ${to}
            AND COALESCE(NULLIF(metadata->>'auditDateTo', ''), metadata->>'auditDateFrom') >= ${from}
          )
          OR (
            NULLIF(metadata->>'auditDateFrom', '') IS NULL
            AND metadata->>'auditDate' >= ${from}
            AND metadata->>'auditDate' <= ${to}
          )
        )
    `;
        break;
      } catch (e) {
        if (!isPrismaRetryableDbError(e)) throw e;
        lastPoolError = e;
        if (attempt < maxAttempts) {
          const waitMs = 250 * attempt;
          this.logger.warn(
            `fetchAudits pool busy (${from}..${to}) attempt ${attempt}/${maxAttempts} — retry in ${waitMs}ms`,
          );
          await this.sleep(waitMs);
          continue;
        }
      }
    }

    if (!rows) {
      if (isPrismaRetryableDbError(lastPoolError)) {
        throw new ServiceUnavailableException(
          'Database đang bận (đồng bộ inbox) — thử lại sau vài giây',
        );
      }
      throw lastPoolError;
    }

    const matched: AuditRow[] = [];
    for (const row of rows) {
      const meta = asRecord(row.metadata);
      if (!auditMatchesActivityFilter(meta, row.transcript, from, to)) continue;

      matched.push({ score: row.score, metadata: row.metadata });

      const range = resolveAuditActivityYmdRange(meta, row.transcript);
      if (range && !meta?.activityDateFrom) {
        void this.backfillActivityDates(row.id, meta, range);
      }
    }
    return matched;
  }

  private async backfillActivityDates(
    auditId: string,
    meta: Record<string, unknown> | null,
    range: { from: string; to: string },
  ): Promise<void> {
    try {
      await this.prisma.chatAudit.update({
        where: { id: auditId },
        data: {
          metadata: {
            ...(meta ?? {}),
            activityDateFrom: range.from,
            activityDateTo: range.to,
          },
        },
      });
    } catch {
      /* không chặn dashboard nếu backfill lỗi */
    }
  }

  /** Tổng hợp theo kênh — bắt đầu từ messages (index sent_at), nhanh hơn EXISTS trên mọi conversation. */
  private async fetchInboxPageOverview(
    from: string,
    to: string,
    tenantId?: string,
  ): Promise<PageOverviewRow[]> {
    const { start, end } = this.graph.vietnamDateRange(from, to);
    const maxAttempts = 3;
    let rows: PageOverviewRow[] | null = null;
    let lastPoolError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        rows = await this.prisma.$queryRaw<PageOverviewRow[]>`
          SELECT
            c.page_id AS "pageId",
            COALESCE(MAX(NULLIF(TRIM(c.page_name), '')), c.page_id) AS "pageName",
            COUNT(*)::int AS "convCount",
            COUNT(*) FILTER (WHERE c.from_ad)::int AS "fromAdCount"
          FROM (
            SELECT DISTINCT m.conversation_id
            FROM cskh_inbox_messages m
            WHERE m.sent_at >= ${start}
              AND m.sent_at <= ${end}
              AND (${tenantId}::uuid IS NULL OR m.tenant_id = ${tenantId}::uuid)
          ) active
          INNER JOIN cskh_inbox_conversations c ON c.id = active.conversation_id
          WHERE (${tenantId}::uuid IS NULL OR c.tenant_id = ${tenantId}::uuid)
          GROUP BY c.page_id
          ORDER BY "convCount" DESC
        `;
        break;
      } catch (e) {
        if (!isPrismaRetryableDbError(e)) throw e;
        lastPoolError = e;
        if (attempt < maxAttempts) {
          await this.sleep(250 * attempt);
          continue;
        }
      }
    }

    if (!rows) {
      if (isPrismaRetryableDbError(lastPoolError)) {
        throw new ServiceUnavailableException(
          'Database đang bận (đồng bộ inbox) — thử lại sau vài giây',
        );
      }
      throw lastPoolError;
    }

    return rows;
  }

  /**
   * Audit stats cho danh sách kênh — chỉ lọc created_at (có index).
   * Bỏ filter JSON metadata dates (rất chậm); đủ cho badge điểm trên UI list.
   */
  private async fetchPageAuditStats(
    from: string,
    to: string,
    tenantId?: string,
  ): Promise<Map<string, PageAuditStat>> {
    type Row = {
      pageId: string;
      auditCount: number;
      avgScore: number;
      passCount: number;
      riskCount: number;
      positiveCount: number;
      neutralCount: number;
      negativeCount: number;
    };

    const { start: createdStart, end: createdEnd } = this.graph.vietnamDateRange(from, to);

    let rows: Row[] = [];
    try {
      rows = await this.prisma.$queryRaw<Row[]>`
        SELECT
          TRIM(metadata->>'pageId') AS "pageId",
          COUNT(*)::int AS "auditCount",
          ROUND(AVG(score)::numeric, 1)::float AS "avgScore",
          COUNT(*) FILTER (WHERE score >= 60)::int AS "passCount",
          COUNT(*) FILTER (
            WHERE score < 50
              OR COALESCE(metadata->'sentiment'->>'tone', '') = 'negative'
          )::int AS "riskCount",
          COUNT(*) FILTER (WHERE COALESCE(metadata->'sentiment'->>'tone', '') = 'positive')::int AS "positiveCount",
          COUNT(*) FILTER (WHERE COALESCE(metadata->'sentiment'->>'tone', '') = 'neutral')::int AS "neutralCount",
          COUNT(*) FILTER (WHERE COALESCE(metadata->'sentiment'->>'tone', '') = 'negative')::int AS "negativeCount"
        FROM chat_audits
        WHERE (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
          AND created_at >= ${createdStart}
          AND created_at <= ${createdEnd}
          AND transcript IS NOT NULL
          AND NULLIF(TRIM(metadata->>'pageId'), '') IS NOT NULL
        GROUP BY TRIM(metadata->>'pageId')
      `;
    } catch (e) {
      this.logger.warn(`fetchPageAuditStats: ${(e as Error).message}`);
      return new Map();
    }

    const out = new Map<string, PageAuditStat>();
    for (const row of rows) {
      if (!row.pageId) continue;
      const total = row.auditCount || 1;
      const sentTotal = row.positiveCount + row.neutralCount + row.negativeCount || total;
      out.set(row.pageId, {
        auditCount: row.auditCount,
        avgScore: row.avgScore,
        passRate: Math.round((row.passCount / total) * 100),
        riskRate: Math.round((row.riskCount / total) * 100),
        positiveRate: Math.round((row.positiveCount / sentTotal) * 100),
      });
    }
    return out;
  }

  /** Audit AI thật theo kênh — nguồn duy nhất cho điểm / chốt / rủi ro / sentiment. */
  private async fetchChannelAuditRows(
    pageId: string,
    from: string,
    to: string,
    tenantId?: string,
  ): Promise<AuditRow[]> {
    const padFrom = addDays(parseYmd(from), -60).toISOString().slice(0, 10);
    const padTo = addDays(parseYmd(to), 14).toISOString().slice(0, 10);
    const { start: createdPadStart } = this.graph.vietnamDateRange(padFrom, padFrom);
    const { end: createdPadEnd } = this.graph.vietnamDateRange(padTo, padTo);
    const { start: rangeStart, end: rangeEnd } = this.graph.vietnamDateRange(from, to);
    const maxRows = Math.min(
      800,
      Math.max(100, Number(process.env.CSKH_INSIGHT_DETAIL_MAX_AUDITS || 400)),
    );

    try {
      const rows = await this.prisma.$queryRaw<AuditRow[]>`
        SELECT score, metadata
        FROM chat_audits
        WHERE (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
          AND created_at >= ${createdPadStart}
          AND created_at <= ${createdPadEnd}
          AND transcript IS NOT NULL
          AND TRIM(metadata->>'pageId') = ${pageId}
          AND (
            (
              NULLIF(metadata->>'activityDateFrom', '') IS NOT NULL
              AND NULLIF(metadata->>'activityDateFrom', '') <= ${to}
              AND COALESCE(NULLIF(metadata->>'activityDateTo', ''), metadata->>'activityDateFrom') >= ${from}
            )
            OR (
              NULLIF(metadata->>'activityDateFrom', '') IS NULL
              AND NULLIF(metadata->>'auditDateFrom', '') IS NOT NULL
              AND metadata->>'auditDateFrom' <= ${to}
              AND COALESCE(NULLIF(metadata->>'auditDateTo', ''), metadata->>'auditDateFrom') >= ${from}
            )
            OR (
              NULLIF(metadata->>'activityDateFrom', '') IS NULL
              AND NULLIF(metadata->>'auditDateFrom', '') IS NULL
              AND NULLIF(metadata->>'auditDate', '') IS NOT NULL
              AND metadata->>'auditDate' >= ${from}
              AND metadata->>'auditDate' <= ${to}
            )
            OR (
              NULLIF(metadata->>'activityDateFrom', '') IS NULL
              AND NULLIF(metadata->>'auditDateFrom', '') IS NULL
              AND NULLIF(metadata->>'auditDate', '') IS NULL
              AND created_at >= ${rangeStart}
              AND created_at <= ${rangeEnd}
            )
          )
        ORDER BY created_at DESC
        LIMIT ${maxRows}
      `;
      return rows ?? [];
    } catch (e) {
      this.logger.warn(`fetchChannelAuditRows page=${pageId}: ${(e as Error).message}`);
      return [];
    }
  }

  private buildPageBreakdownFromOverview(
    current: PageOverviewRow[],
    auditByPage: Map<string, PageAuditStat>,
  ) {
    const minRank = 3;

    const all: PageInsightRow[] = current
      .filter((p) => p.convCount > 0)
      .map((p) => {
        const audit = auditByPage.get(p.pageId);
        if (!audit || audit.auditCount <= 0) {
          return {
            pageId: p.pageId,
            pageName: p.pageName,
            auditCount: p.convCount,
            audited: false,
            avgScore: null,
            passRate: null,
            riskRate: null,
            positiveRate: null,
            scoreChange: null,
            status: 'pending' as const,
            statusLabel: 'Chưa audit',
            topIssue: p.fromAdCount > 0 ? `${p.fromAdCount} hội thoại từ quảng cáo` : null,
            topKeyword: null,
          };
        }

        const avgScore = Math.round(audit.avgScore * 10) / 10;
        const riskRate = audit.riskRate;
        const status = pageStatus(avgScore, riskRate);
        return {
          pageId: p.pageId,
          pageName: p.pageName,
          auditCount: p.convCount,
          audited: true,
          avgScore,
          passRate: audit.passRate,
          riskRate,
          positiveRate: audit.positiveRate,
          scoreChange: null,
          status,
          statusLabel: statusLabel(status),
          topIssue: p.fromAdCount > 0 ? `${p.fromAdCount} hội thoại từ quảng cáo` : null,
          topKeyword: null,
        };
      })
      .sort((a, b) => {
        if (a.audited !== b.audited) return a.audited ? -1 : 1;
        return (b.avgScore ?? 0) - (a.avgScore ?? 0);
      });

    return {
      all,
      needsAttention: all.filter((p) => p.audited && p.status !== 'good' && p.auditCount >= minRank).slice(0, 8),
      topPerformers: [...all]
        .filter((p) => p.audited && p.status === 'good' && p.auditCount >= minRank)
        .sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0))
        .slice(0, 8),
      summary: {
        good: all.filter((p) => p.audited && p.status === 'good').length,
        warning: all.filter((p) => p.audited && p.status === 'warning').length,
        critical: all.filter((p) => p.audited && p.status === 'critical').length,
        total: all.length,
      },
    };
  }

  /** Đếm hội thoại có tin nhắn trong kỳ — nhẹ, không gom nội dung. */
  private async fetchInboxConvCount(
    from: string,
    to: string,
    tenantId?: string,
    pageId?: string,
  ): Promise<number> {
    const { start, end } = this.graph.vietnamDateRange(from, to);
    const maxAttempts = 3;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const rows = pageId
          ? await this.prisma.$queryRaw<{ count: number }[]>`
              SELECT COUNT(*)::int AS count
              FROM (
                SELECT DISTINCT m.conversation_id
                FROM cskh_inbox_messages m
                INNER JOIN cskh_inbox_conversations c ON c.id = m.conversation_id
                WHERE m.sent_at >= ${start}
                  AND m.sent_at <= ${end}
                  AND c.page_id = ${pageId}
                  AND (${tenantId}::uuid IS NULL OR c.tenant_id = ${tenantId}::uuid)
              ) t
            `
          : await this.prisma.$queryRaw<{ count: number }[]>`
              SELECT COUNT(*)::int AS count
              FROM (
                SELECT DISTINCT m.conversation_id
                FROM cskh_inbox_messages m
                WHERE m.sent_at >= ${start}
                  AND m.sent_at <= ${end}
                  AND (${tenantId}::uuid IS NULL OR m.tenant_id = ${tenantId}::uuid)
              ) t
            `;
        return rows[0]?.count ?? 0;
      } catch (e) {
        if (!isPrismaRetryableDbError(e)) throw e;
        lastError = e;
        if (attempt < maxAttempts) {
          await this.sleep(250 * attempt);
          continue;
        }
      }
    }

    if (isPrismaRetryableDbError(lastError)) {
      throw new ServiceUnavailableException(
        'Database đang bận — thử lại sau vài giây',
      );
    }
    throw lastError;
  }

  /** Lấy hội thoại inbox có tin nhắn trong khoảng ngày (VN) — dùng khi xem chi tiết 1 kênh. */
  private async fetchInboxRows(
    from: string,
    to: string,
    tenantId?: string,
    pageId?: string,
    productIndex?: ReturnType<typeof buildProductSearchIndex>,
  ): Promise<AuditRow[]> {
    const { start, end } = this.graph.vietnamDateRange(from, to);
    const maxConv = pageId
      ? Math.min(
          1000,
          Math.max(100, Number(process.env.CSKH_INSIGHT_DETAIL_MAX_CONVERSATIONS || 200)),
        )
      : Math.min(
          10_000,
          Math.max(500, Number(process.env.CSKH_INSIGHT_MAX_CONVERSATIONS || 5000)),
        );

    type ConvAggRow = {
      conversationId: string;
      pageId: string;
      pageName: string | null;
      participantPsid: string;
      customerName: string | null;
      fromAd: boolean;
      adId: string | null;
      adTitle: string | null;
      referralSource: string | null;
      inboundText: string;
      messageCount: number;
    };

    const maxAttempts = 3;
    let rows: ConvAggRow[] | null = null;
    let lastPoolError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (pageId) {
          rows = await this.prisma.$queryRaw<ConvAggRow[]>`
            WITH picked AS (
              SELECT
                c.id,
                c.page_id,
                c.page_name,
                c.participant_psid,
                c.customer_name,
                c.from_ad,
                c.ad_id,
                c.ad_title,
                c.referral_source
              FROM cskh_inbox_conversations c
              WHERE (${tenantId}::uuid IS NULL OR c.tenant_id = ${tenantId}::uuid)
                AND c.page_id = ${pageId}
                AND (c.last_message_at IS NULL OR c.last_message_at >= ${start})
                AND EXISTS (
                  SELECT 1
                  FROM cskh_inbox_messages m
                  WHERE m.conversation_id = c.id
                    AND m.sent_at >= ${start}
                    AND m.sent_at <= ${end}
                )
              ORDER BY c.last_message_at DESC NULLS LAST
              LIMIT ${maxConv}
            ),
            msg_stats AS (
              SELECT
                m.conversation_id,
                COUNT(*)::int AS message_count
              FROM cskh_inbox_messages m
              INNER JOIN picked p ON p.id = m.conversation_id
              WHERE m.sent_at >= ${start}
                AND m.sent_at <= ${end}
              GROUP BY m.conversation_id
            )
            SELECT
              p.id AS "conversationId",
              p.page_id AS "pageId",
              p.page_name AS "pageName",
              p.participant_psid AS "participantPsid",
              p.customer_name AS "customerName",
              p.from_ad AS "fromAd",
              p.ad_id AS "adId",
              p.ad_title AS "adTitle",
              p.referral_source AS "referralSource",
              ms.message_count AS "messageCount",
              COALESCE(ib.inbound_text, '') AS "inboundText"
            FROM picked p
            INNER JOIN msg_stats ms ON ms.conversation_id = p.id
            LEFT JOIN LATERAL (
              SELECT string_agg(LEFT(x.text, 120), ' ' ORDER BY x.sent_at) AS inbound_text
              FROM (
                SELECT m2.text, m2.sent_at
                FROM cskh_inbox_messages m2
                WHERE m2.conversation_id = p.id
                  AND m2.sent_at >= ${start}
                  AND m2.sent_at <= ${end}
                  AND (m2.direction = 'inbound' OR m2.sender_type = 'customer')
                ORDER BY m2.sent_at DESC
                LIMIT 2
              ) x
            ) ib ON true
          `;
        } else {
          rows = await this.prisma.$queryRaw<ConvAggRow[]>`
            SELECT
              c.id AS "conversationId",
              c.page_id AS "pageId",
              c.page_name AS "pageName",
              c.participant_psid AS "participantPsid",
              c.customer_name AS "customerName",
              c.from_ad AS "fromAd",
              c.ad_id AS "adId",
              c.ad_title AS "adTitle",
              c.referral_source AS "referralSource",
              stats.message_count AS "messageCount",
              stats.inbound_text AS "inboundText"
            FROM cskh_inbox_conversations c
            INNER JOIN LATERAL (
              SELECT
                COUNT(*)::int AS message_count,
                COALESCE((
                  SELECT string_agg(LEFT(x.text, 200), ' ' ORDER BY x.sent_at)
                  FROM (
                    SELECT m2.text, m2.sent_at
                    FROM cskh_inbox_messages m2
                    WHERE m2.conversation_id = c.id
                      AND m2.sent_at >= ${start}
                      AND m2.sent_at <= ${end}
                      AND (m2.direction = 'inbound' OR m2.sender_type = 'customer')
                    ORDER BY m2.sent_at DESC
                    LIMIT 3
                  ) x
                ), '') AS inbound_text
              FROM cskh_inbox_messages m
              WHERE m.conversation_id = c.id
                AND m.sent_at >= ${start}
                AND m.sent_at <= ${end}
            ) stats ON stats.message_count > 0
            WHERE (${tenantId}::uuid IS NULL OR c.tenant_id = ${tenantId}::uuid)
              AND (c.last_message_at IS NULL OR c.last_message_at >= ${start})
            ORDER BY c.last_message_at DESC NULLS LAST
            LIMIT ${maxConv}
          `;
        }
        break;
      } catch (e) {
        if (!isPrismaRetryableDbError(e)) throw e;
        lastPoolError = e;
        if (attempt < maxAttempts) {
          const waitMs = 250 * attempt;
          this.logger.warn(
            `fetchInboxRows DB busy (${from}..${to}${pageId ? ` page=${pageId}` : ''}) attempt ${attempt}/${maxAttempts}`,
          );
          await this.sleep(waitMs);
          continue;
        }
      }
    }

    if (!rows) {
      if (isPrismaRetryableDbError(lastPoolError)) {
        throw new ServiceUnavailableException(
          'Database đang bận — thử lại sau vài giây',
        );
      }
      throw lastPoolError;
    }

    const skipLabels = true;
    const labelsByConv = skipLabels
      ? new Map<string, string[]>()
      : await this.loadInboxLabelsForConversations(rows.map((r) => r.conversationId));

    return rows.map((row) => {
      const built = buildInboxSyntheticAuditRow(
        {
          ...row,
          labelNames: labelsByConv.get(row.conversationId) ?? [],
        },
        from,
        to,
        productIndex,
      );
      return { score: built.score, metadata: built.metadata };
    });
  }

  private async loadInboxLabelsForConversations(
    conversationIds: string[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!conversationIds.length) return out;

    const chunkSize = 400;
    for (let i = 0; i < conversationIds.length; i += chunkSize) {
      const chunk = conversationIds.slice(i, i + chunkSize);
      try {
        const assignments = await this.prisma.cskhInboxConversationLabel.findMany({
          where: { conversationId: { in: chunk } },
          select: {
            conversationId: true,
            label: { select: { name: true } },
          },
        });
        for (const a of assignments) {
          const list = out.get(a.conversationId) ?? [];
          if (a.label?.name) list.push(a.label.name);
          out.set(a.conversationId, list);
        }
      } catch {
        /* nhãn là optional */
      }
    }
    return out;
  }

  private groupByPage(rows: AuditRow[]): PageBucket[] {
    const map = new Map<string, PageBucket>();
    for (const row of rows) {
      const meta = asRecord(row.metadata);
      const pageId = typeof meta?.pageId === 'string' && meta.pageId.trim() ? meta.pageId.trim() : '_unknown';
      const pageName =
        typeof meta?.pageName === 'string' && meta.pageName.trim() ? meta.pageName.trim() : `Kênh #${pageId}`;
      const bucket = map.get(pageId) ?? { pageId, pageName, rows: [] };
      bucket.rows.push(row);
      map.set(pageId, bucket);
    }
    return [...map.values()];
  }

  private buildPageInsight(
    bucket: PageBucket,
    agg: PageAgg,
    prevAgg?: PageAgg,
  ): PageInsightRow {
    const passRate = agg.total > 0 ? Math.round((agg.passCount / agg.total) * 100) : 0;
    const riskRate = agg.total > 0 ? Math.round((agg.riskCount / agg.total) * 100) : 0;
    const sentTotal = agg.sentiment.positive + agg.sentiment.neutral + agg.sentiment.negative || 1;
    const positiveRate = Math.round((agg.sentiment.positive / sentTotal) * 100);
    const avgScore = Math.round(agg.avgScore * 10) / 10;
    const scoreChange =
      prevAgg && prevAgg.total > 0
        ? Math.round((avgScore - prevAgg.avgScore) * 10) / 10
        : null;
    const status = pageStatus(avgScore, riskRate);
    const topWeak = topEntries(agg.weaknesses, 1)[0];
    const topKw = topEntries(agg.keywords, 1)[0];

    return {
      pageId: bucket.pageId,
      pageName: bucket.pageName,
      auditCount: agg.total,
      audited: true,
      avgScore,
      passRate,
      riskRate,
      positiveRate,
      scoreChange,
      status,
      statusLabel: statusLabel(status),
      topIssue: topWeak ? (topWeak.label.length > 72 ? `${topWeak.label.slice(0, 69)}...` : topWeak.label) : null,
      topKeyword: topKw ? topKw.label : null,
    };
  }

  private buildPageBreakdown(
    currentRows: AuditRow[],
    prevRows: AuditRow[],
  ): {
    all: PageInsightRow[];
    needsAttention: PageInsightRow[];
    topPerformers: PageInsightRow[];
    summary: { good: number; warning: number; critical: number; total: number };
  } {
    const prevBuckets = new Map(
      this.groupByPage(prevRows).map((b) => [b.pageId, this.aggregate(b.rows)]),
    );

    const all = this.groupByPage(currentRows)
      .map((bucket) => {
        const agg = this.aggregate(bucket.rows);
        const prevAgg = prevBuckets.get(bucket.pageId);
        return this.buildPageInsight(bucket, agg, prevAgg);
      })
      .filter((p) => p.auditCount > 0)
      .sort((a, b) => (a.avgScore ?? 0) - (b.avgScore ?? 0));

    const minRank = 3;
    const needsAttention = all
      .filter((p) => p.status !== 'good' && p.auditCount >= minRank)
      .slice(0, 8);
    const topPerformers = [...all]
      .filter((p) => p.status === 'good' && p.auditCount >= minRank)
      .sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0))
      .slice(0, 8);

    const summary = {
      good: all.filter((p) => p.status === 'good').length,
      warning: all.filter((p) => p.status === 'warning').length,
      critical: all.filter((p) => p.status === 'critical').length,
      total: all.length,
    };

    return { all, needsAttention, topPerformers, summary };
  }

  private aggregate(rows: AuditRow[], totalOverride?: number) {
    const keywords = new Map<string, number>();
    const strengths = new Map<string, number>();
    const weaknesses = new Map<string, number>();
    const tags = new Map<string, number>();
    const products = new Map<string, number>();
    const productLabels = new Map<string, string>();
    const intents = new Map<string, number>();
    const adSources = new Map<string, { count: number; pass: number; fromAd: number }>();

    let positive = 0;
    let neutral = 0;
    let negative = 0;
    let riskCount = 0;
    let abnormalCount = 0;
    let highClose = 0;
    let lowClose = 0;
    let passCount = 0;
    const scores: number[] = [];

    for (const row of rows) {
      const meta = asRecord(row.metadata);
      scores.push(row.score);
      if (row.score >= 60) passCount += 1;

      for (const kw of asStringArray(meta?.keywords)) bumpMap(keywords, kw);
      for (const t of asStringArray(meta?.tags)) bumpMap(tags, t);
      for (const s of asStringArray(meta?.strengths)) {
        if (isActionableStrength(s)) bumpMap(strengths, s.slice(0, 80));
      }
      for (const w of asStringArray(meta?.weaknesses)) {
        if (isActionableWeakness(w)) bumpMap(weaknesses, w.slice(0, 80));
      }

      const ci = asRecord(meta?.customerIntent);
      for (const p of asStringArray(ci?.productMentions)) bumpProductMap(products, productLabels, p);
      const il = intentLabel(meta);
      if (il) bumpMap(intents, il);

      const tone = sentimentTone(meta);
      if (tone === 'positive') positive += 1;
      else if (tone === 'negative') negative += 1;
      else neutral += 1;

      const closing = closingScore(meta);
      const isHigh = row.score >= 75 || (closing != null && closing >= 15);
      const isLow = row.score < 55 || (closing != null && closing < 8);
      if (isHigh) highClose += 1;
      if (isLow) lowClose += 1;

      const hasViolation =
        typeof meta?.violations === 'string' && meta.violations.trim().length > 0;
      if (row.score < 50 || tone === 'negative' || (row.score < 60 && hasViolation)) riskCount += 1;

      const urgency = ci?.urgency;
      if (row.score < 40 || urgency === 'high') abnormalCount += 1;

      const pageName = typeof meta?.pageName === 'string' ? meta.pageName : 'Khác';
      const fromAd = meta?.fromAd === true;
      const adTitle = typeof meta?.adTitle === 'string' && meta.adTitle.trim() ? meta.adTitle.trim() : null;
      const sourceKey = fromAd ? adTitle || 'Quảng cáo (không tên)' : 'Tin nhắn tự nhiên';
      const cur = adSources.get(sourceKey) ?? { count: 0, pass: 0, fromAd: fromAd ? 1 : 0 };
      cur.count += 1;
      if (row.score >= 60) cur.pass += 1;
      adSources.set(sourceKey, cur);
    }

    const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const scoreP10 = scores.length ? [...scores].sort((a, b) => a - b)[Math.floor(scores.length * 0.1)] : 0;

    return {
      total: totalOverride ?? rows.length,
      keywords,
      strengths,
      weaknesses,
      tags,
      products,
      productLabels,
      intents,
      sentiment: { positive, neutral, negative },
      riskCount,
      abnormalCount,
      highClose,
      lowClose,
      passCount,
      avgScore,
      scoreP10,
      adSources,
    };
  }

  private buildConcernDonut(
    topics: Map<string, number>,
    labels: Map<string, string>,
    _total: number,
  ) {
    const top = topEntries(topics, 6, (k) => productLabel(labels, k));
    if (!top.length) return { total: 0, items: [] };
    const mentionSum = top.reduce((s, x) => s + x.count, 0) || 1;
    const items = top.map((x, i) => ({
      label: x.label,
      count: x.count,
      pct: Math.round((x.count / mentionSum) * 100),
      color: CONCERN_COLORS[i % CONCERN_COLORS.length],
    }));
    return { total: mentionSum, items };
  }

  private buildCloseFactors(strengths: Map<string, number>, weaknesses: Map<string, number>) {
    const toFactors = (entries: ReturnType<typeof topEntries>, total: number) =>
      entries.map((x) => ({
        label: x.label.length > 60 ? `${x.label.slice(0, 57)}...` : x.label,
        pct: total > 0 ? Math.round((x.count / total) * 100) : 0,
        count: x.count,
      }));

    const highTotal = [...strengths.values()].reduce((a, b) => a + b, 0) || 1;
    const lowTotal = [...weaknesses.values()].reduce((a, b) => a + b, 0) || 1;

    return {
      highClose: toFactors(topEntries(strengths, 5), highTotal),
      lostOrders: toFactors(topEntries(weaknesses, 5), lowTotal),
    };
  }

  /** Nguồn ads từ inbox thật — không gắn % QA giả khi chưa audit. */
  private buildInboxAdSources(
    adSources: Map<string, { count: number; pass: number; fromAd: number }>,
    hasAuditQa: boolean,
  ) {
    return [...adSources.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6)
      .map(([name, s]) => {
        if (!hasAuditQa) {
          return {
            name,
            quality: 'Inbox',
            stars: 0,
            closeRate: `${s.count.toLocaleString('vi-VN')} hội thoại`,
            roas: s.fromAd ? 'Ads' : 'Organic',
            conversationCount: s.count,
          };
        }
        const passRate = s.count > 0 ? s.pass / s.count : 0;
        const stars = Math.min(5, Math.max(1, Math.round(passRate * 5)));
        return {
          name,
          quality: passRate >= 0.7 ? 'Tốt' : passRate >= 0.5 ? 'Khá' : 'Cần cải thiện',
          stars,
          closeRate: `${Math.round(passRate * 100)}% đạt QA`,
          roas: s.fromAd ? '—' : 'N/A',
          conversationCount: s.count,
        };
      });
  }

  private buildVideoTopics(products: Map<string, number>, productLabels: Map<string, string>) {
    const top = topEntries(products, 5, (k) => productLabel(productLabels, k));
    if (!top.length) return [];

    return top.map((x, i) => {
      const topic = buildProductVideoTopic(x.label, x.count, i);
      return {
        question: topic.question,
        mentions: x.count,
        audience: 'Khách inbox / quảng cáo',
        angle: topic.angle,
        hook: topic.hook,
        script: topic.script,
        cta: topic.cta,
      };
    });
  }

  private buildAdEfficiency(adSources: Map<string, { count: number; pass: number; fromAd: number }>) {
    return [...adSources.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6)
      .map(([name, s]) => {
        const passRate = s.count > 0 ? s.pass / s.count : 0;
        const stars = Math.min(5, Math.max(1, Math.round(passRate * 5)));
        return {
          name,
          quality: passRate >= 0.7 ? 'Tốt' : passRate >= 0.5 ? 'Khá' : 'Cần cải thiện',
          stars,
          closeRate: `${Math.round(passRate * 100)}% đạt QA`,
          roas: s.fromAd ? '—' : 'N/A',
          conversationCount: s.count,
        };
      });
  }

  private buildProducts(products: Map<string, number>, productLabels: Map<string, string>) {
    const top = topEntries(products, 8, (k) => productLabel(productLabels, k));
    return top.map((x) => ({
      name: x.label,
      visits: x.count,
      closeRate: '—',
      revenue: '—',
    }));
  }

  private topicMapForDisplay(products: Map<string, number>, keywords: Map<string, number>) {
    return products.size > 0 ? products : keywords;
  }

  async getDashboard(params: {
    auditDateFrom: string;
    auditDateTo?: string;
    pageId?: string;
    tenantId?: string;
  }) {
    const from = params.auditDateFrom.trim();
    const to = (params.auditDateTo?.trim() || from).trim();
    this.validateRange(from, to);

    const fromDate = parseYmd(from);
    const toDate = parseYmd(to);
    const daySpan = Math.max(1, Math.round((toDate.getTime() - fromDate.getTime()) / 86400000) + 1);
    const prevTo = addDays(fromDate, -1);
    const prevFrom = addDays(prevTo, -(daySpan - 1));
    const prevFromStr = prevFrom.toISOString().slice(0, 10);
    const prevToStr = prevTo.toISOString().slice(0, 10);

    const pageId = params.pageId?.trim();

    if (!pageId) {
      const cacheKey = `${params.tenantId ?? '__all__'}:${from}:${to}:all`;
      const cachedOverview = this.dashboardCache.get(cacheKey);
      if (cachedOverview && Date.now() - cachedOverview.at < this.dashboardCacheTtlMs) {
        return cachedOverview.data;
      }

      // Chỉ 2 query (bỏ scan kỳ trước — trước đó fetch nhưng không dùng cho byPage).
      // Giảm tải DB / connection pool để không ảnh hưởng inbox sync & API khác.
      const [currentPages, auditByPage] = await Promise.all([
        this.fetchInboxPageOverview(from, to, params.tenantId),
        this.fetchPageAuditStats(from, to, params.tenantId),
      ]);
      const byPage = this.buildPageBreakdownFromOverview(currentPages, auditByPage);
      const auditedPages = byPage.all.filter((p) => p.audited);
      const avgAuditedScore =
        auditedPages.length > 0
          ? Math.round(
              (auditedPages.reduce((s, p) => s + (p.avgScore ?? 0), 0) / auditedPages.length) * 10,
            ) / 10
          : 0;
      const totalConv = currentPages.reduce((s, p) => s + p.convCount, 0);

      const result = {
        source: 'cskh_inbox' as const,
        period: { from, to, label: `${formatVnDate(from)} - ${formatVnDate(to)}` },
        previousPeriod: { from: prevFromStr, to: prevToStr },
        selectedPageId: null,
        selectedPageName: null,
        totalAnalyzed: totalConv,
        avgScore: avgAuditedScore,
        intro: `${totalConv.toLocaleString('vi-VN')} hội thoại inbox trên ${byPage.summary.total} kênh · ${auditedPages.length} kênh đã audit (${formatVnDate(from)} - ${formatVnDate(to)})`,
        kpis: [
          {
            label: 'Hội thoại có hoạt động',
            value: totalConv.toLocaleString('vi-VN'),
            unit: '',
            change: '—',
            changePositive: true,
            sub: 'chọn kênh để so sánh kỳ trước',
          },
          {
            label: 'Vấn đề rủi ro',
            value: '0',
            unit: ' hội thoại',
            change: '—',
            changePositive: true,
            sub: 'chọn kênh để xem chi tiết',
          },
          {
            label: 'Xu hướng tăng mạnh',
            value: '—',
            unit: '',
            change: '—',
            changePositive: true,
            sub: 'chọn kênh để xem từ khóa',
          },
          {
            label: 'Hội thoại bất thường',
            value: '0',
            unit: ' case',
            change: '—',
            changePositive: true,
            sub: 'chọn kênh để phân tích',
          },
        ],
        customerConcerns: { total: 0, items: [] },
        closeRateFactors: { highClose: [], lostOrders: [] },
        videoTopics: [],
        products: [],
        sentiment: { positive: 0, neutral: 100, negative: 0, positiveChange: 0 },
        adEfficiency: [],
        highCloseRate: 0,
        lowCloseRate: 0,
        byPage,
        pageDirectory: byPage.all,
        byCountry: [] as { country: string; flag: string; insight: string; closeRate: string }[],
      };

      this.dashboardCache.set(cacheKey, { at: Date.now(), data: result });
      if (this.dashboardCache.size > 80) {
        const oldest = this.dashboardCache.keys().next().value;
        if (oldest) this.dashboardCache.delete(oldest);
      }
      return result;
    }

    const catalog = await this.sapoProducts.getCatalog();
    const productIndex = catalog.length ? buildProductSearchIndex(catalog) : undefined;
    const detailCacheKey = `${params.tenantId ?? '__all__'}:${from}:${to}:${pageId}:p${catalog.length}`;
    const cachedDetail = this.dashboardCache.get(detailCacheKey);
    if (cachedDetail && Date.now() - cachedDetail.at < this.dashboardCacheTtlMs) {
      return cachedDetail.data;
    }

    const [curTotal, prevTotal, currentRows, auditRows] = await Promise.all([
      this.fetchInboxConvCount(from, to, params.tenantId, pageId),
      this.fetchInboxConvCount(prevFromStr, prevToStr, params.tenantId, pageId),
      this.fetchInboxRows(from, to, params.tenantId, pageId, productIndex),
      this.fetchChannelAuditRows(pageId, from, to, params.tenantId),
    ]);

    const hasAudit = auditRows.length > 0;
    const curInbox = this.aggregate(currentRows, curTotal);
    const curAudit = hasAudit ? this.aggregate(auditRows) : null;
    const prev = this.aggregate([], prevTotal);

    // Inbox = volume / chủ đề / sản phẩm / ads. Audit = điểm QA / chốt / rủi ro / sentiment.
    const displayTopics = this.topicMapForDisplay(curInbox.products, curInbox.keywords);
    const topicLabel = (k: string) =>
      curInbox.products.size > 0 ? productLabel(curInbox.productLabels, k) : k;
    const growing = topEntries(displayTopics, 20, topicLabel)[0];
    const totalChange = pctChange(curInbox.total, prev.total);

    const sentimentPct = curAudit
      ? (() => {
          const t =
            curAudit.sentiment.positive + curAudit.sentiment.neutral + curAudit.sentiment.negative || 1;
          return {
            positive: Math.round((curAudit.sentiment.positive / t) * 100),
            neutral: Math.round((curAudit.sentiment.neutral / t) * 100),
            negative: Math.round((curAudit.sentiment.negative / t) * 100),
          };
        })()
      : { positive: 0, neutral: 0, negative: 0 };

    const selectedPageName =
      currentRows.length > 0
        ? (typeof asRecord(currentRows[0].metadata)?.pageName === 'string'
            ? (asRecord(currentRows[0].metadata)!.pageName as string)
            : `Kênh #${pageId}`)
        : hasAudit && typeof asRecord(auditRows[0].metadata)?.pageName === 'string'
          ? (asRecord(auditRows[0].metadata)!.pageName as string)
          : null;

    const avgScore = curAudit ? Math.round(curAudit.avgScore * 10) / 10 : null;
    const riskCount = curAudit ? curAudit.riskCount : null;
    const abnormalCount = curAudit ? curAudit.abnormalCount : null;
    const closeRateFactors = curAudit
      ? this.buildCloseFactors(curAudit.strengths, curAudit.weaknesses)
      : { highClose: [] as { label: string; pct: number; count: number }[], lostOrders: [] as { label: string; pct: number; count: number }[] };

    const result = {
      source: 'cskh_inbox' as const,
      period: { from, to, label: `${formatVnDate(from)} - ${formatVnDate(to)}` },
      previousPeriod: { from: prevFromStr, to: prevToStr },
      selectedPageId: pageId ?? null,
      selectedPageName,
      audited: hasAudit,
      auditCount: auditRows.length,
      totalAnalyzed: curInbox.total,
      avgScore,
      intro: pageId && selectedPageName
        ? hasAudit
          ? `Kênh «${selectedPageName}» — ${curInbox.total.toLocaleString('vi-VN')} hội thoại inbox · ${auditRows.length} bản ghi đã audit (${formatVnDate(from)} - ${formatVnDate(to)})`
          : `Kênh «${selectedPageName}» — ${curInbox.total.toLocaleString('vi-VN')} hội thoại inbox · Chưa audit trong kỳ (${formatVnDate(from)} - ${formatVnDate(to)})`
        : `${curInbox.total.toLocaleString('vi-VN')} hội thoại inbox (${formatVnDate(from)} - ${formatVnDate(to)})`,
      kpis: [
        {
          label: 'Hội thoại có hoạt động',
          value: curInbox.total.toLocaleString('vi-VN'),
          unit: '',
          change: totalChange.text,
          changePositive: totalChange.positive,
          sub: `so với ${prev.total.toLocaleString('vi-VN')} kỳ trước (inbox)`,
        },
        {
          label: 'Vấn đề rủi ro',
          value: hasAudit ? String(riskCount) : '—',
          unit: hasAudit ? ' hội thoại' : '',
          change: '—',
          changePositive: true,
          sub: hasAudit ? 'từ audit Chất lượng CSKH' : 'chạy Chất lượng CSKH để có data',
        },
        {
          label: 'Xu hướng tăng mạnh',
          value: growing ? growing.label : '—',
          unit: growing ? ` (${growing.count})` : '',
          change: '—',
          changePositive: true,
          sub: growing ? 'từ khóa / sản phẩm từ inbox' : 'chưa đủ dữ liệu inbox',
        },
        {
          label: 'Hội thoại bất thường',
          value: hasAudit ? String(abnormalCount) : '—',
          unit: hasAudit ? ' case' : '',
          change: '—',
          changePositive: true,
          sub: hasAudit ? 'điểm thấp / urgency cao (audit)' : 'chạy Chất lượng CSKH để có data',
        },
      ],
      customerConcerns: this.buildConcernDonut(displayTopics, curInbox.productLabels, curInbox.total),
      closeRateFactors,
      videoTopics: this.buildVideoTopics(curInbox.products, curInbox.productLabels),
      products: this.buildProducts(curInbox.products, curInbox.productLabels),
      sentiment: hasAudit
        ? { ...sentimentPct, positiveChange: 0 }
        : { positive: 0, neutral: 0, negative: 0, positiveChange: 0 },
      adEfficiency: this.buildInboxAdSources(curInbox.adSources, false),
      highCloseRate: curAudit && curAudit.total > 0 ? Math.round((curAudit.highClose / curAudit.total) * 100) : null,
      lowCloseRate: curAudit && curAudit.total > 0 ? Math.round((curAudit.lowClose / curAudit.total) * 100) : null,
      byPage: null,
      // Không ghi đè directory FE bằng điểm giả từ inbox.
      pageDirectory: [],
      byCountry: [] as { country: string; flag: string; insight: string; closeRate: string }[],
    };

    this.dashboardCache.set(detailCacheKey, { at: Date.now(), data: result });
    if (this.dashboardCache.size > 80) {
      const oldest = this.dashboardCache.keys().next().value;
      if (oldest) this.dashboardCache.delete(oldest);
    }
    return result;
  }
}
