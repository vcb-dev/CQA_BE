import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const CONCERN_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899'];

type AuditRow = {
  score: number;
  metadata: Record<string, unknown> | null;
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
  avgScore: number;
  passRate: number;
  riskRate: number;
  positiveRate: number;
  scoreChange: number | null;
  status: 'good' | 'warning' | 'critical';
  statusLabel: string;
  topIssue: string | null;
  topKeyword: string | null;
};

function pageStatus(avgScore: number, riskRate: number): PageInsightRow['status'] {
  if (avgScore < 55 || riskRate >= 55) return 'critical';
  if (avgScore < 65 || riskRate >= 35) return 'warning';
  return 'good';
}

function statusLabel(status: PageInsightRow['status']): string {
  if (status === 'good') return 'Ổn định';
  if (status === 'warning') return 'Cần cải thiện';
  return 'Cần xử lý gấp';
}

@Injectable()
export class CskhInsightService {
  constructor(private readonly prisma: PrismaService) {}

  private validateRange(from: string, to: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new BadRequestException('Ngày không hợp lệ (YYYY-MM-DD)');
    }
    if (from > to) throw new BadRequestException('auditDateFrom phải ≤ auditDateTo');
  }

  private async fetchAudits(from: string, to: string, tenantId?: string): Promise<AuditRow[]> {
    const start = parseYmd(from);
    const endExclusive = addDays(parseYmd(to), 1);
    return this.prisma.$queryRaw<AuditRow[]>`
      SELECT score, metadata
      FROM chat_audits
      WHERE created_at >= ${start}
        AND created_at < ${endExclusive}
        AND (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
    `;
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
      .sort((a, b) => a.avgScore - b.avgScore);

    const minRank = 3;
    const needsAttention = all
      .filter((p) => p.status !== 'good' && p.auditCount >= minRank)
      .slice(0, 8);
    const topPerformers = [...all]
      .filter((p) => p.status === 'good' && p.auditCount >= minRank)
      .sort((a, b) => b.avgScore - a.avgScore)
      .slice(0, 8);

    const summary = {
      good: all.filter((p) => p.status === 'good').length,
      warning: all.filter((p) => p.status === 'warning').length,
      critical: all.filter((p) => p.status === 'critical').length,
      total: all.length,
    };

    return { all, needsAttention, topPerformers, summary };
  }

  private aggregate(rows: AuditRow[]) {
    const keywords = new Map<string, number>();
    const strengths = new Map<string, number>();
    const weaknesses = new Map<string, number>();
    const tags = new Map<string, number>();
    const products = new Map<string, number>();
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
      for (const p of asStringArray(ci?.productMentions)) bumpMap(products, p);
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
      total: rows.length,
      keywords,
      strengths,
      weaknesses,
      tags,
      products,
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

  private buildConcernDonut(keywords: Map<string, number>, total: number) {
    const top = topEntries(keywords, 6);
    const mentionSum = top.reduce((s, x) => s + x.count, 0) || 1;
    const items = top.map((x, i) => ({
      label: x.label.charAt(0).toUpperCase() + x.label.slice(1),
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

  private buildVideoTopics(keywords: Map<string, number>) {
    const top = topEntries(keywords, 5);
    return top.map((x) => {
      const q = x.label.includes('?') ? x.label : `Khách thường hỏi về "${x.label}"?`;
      return {
        question: q.charAt(0).toUpperCase() + q.slice(1),
        mentions: x.count,
        audience: 'Khách inbox / quảng cáo',
        angle: `Video FAQ giải đáp: ${x.label}`,
        hook: `Câu hỏi "${x.label}" xuất hiện ${x.count} lần trong hội thoại đã chấm.`,
        script: [
          `Mở đầu bằng câu hỏi thực tế khách hay hỏi: ${x.label}.`,
          'Trả lời ngắn gọn, có ví dụ sản phẩm hoặc tình huống cụ thể.',
          'Demo / unbox / so sánh nếu liên quan đến sản phẩm.',
          'Chốt bằng CTA nhắn inbox hoặc comment để được tư vấn thêm.',
        ],
        cta: `Nhắn "${x.label}" để shop tư vấn chi tiết.`,
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

  private buildProducts(products: Map<string, number>, keywords: Map<string, number>) {
    const source = products.size > 0 ? products : keywords;
    const top = topEntries(source, 5);
    return top.map((x) => ({
      name: x.label.charAt(0).toUpperCase() + x.label.slice(1),
      visits: x.count,
      closeRate: '—',
      revenue: '—',
    }));
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

    let currentRows = await this.fetchAudits(from, to, params.tenantId);
    let prevRows = await this.fetchAudits(prevFromStr, prevToStr, params.tenantId);

    const byPage = this.buildPageBreakdown(currentRows, prevRows);

    const pageId = params.pageId?.trim();
    if (pageId) {
      const matchPage = (meta: Record<string, unknown> | null) => meta?.pageId === pageId;
      currentRows = currentRows.filter((r) => matchPage(asRecord(r.metadata)));
      prevRows = prevRows.filter((r) => matchPage(asRecord(r.metadata)));
    }

    const cur = this.aggregate(currentRows);
    const prev = this.aggregate(prevRows);

    const growing = topEntries(cur.keywords, 20)
      .map((x) => {
        const prevCount = prev.keywords.get(x.key) ?? 0;
        const growth = prevCount > 0 ? ((x.count - prevCount) / prevCount) * 100 : x.count > 0 ? 100 : 0;
        return { ...x, growth };
      })
      .sort((a, b) => b.growth - a.growth)[0];

    const riskChange = pctChange(cur.riskCount, prev.riskCount);
    const abnormalChange = pctChange(cur.abnormalCount, prev.abnormalCount);
    const totalChange = pctChange(cur.total, prev.total);
    const trendingChange = growing
      ? pctChange(growing.count, prev.keywords.get(growing.key) ?? 0)
      : { text: '—', positive: true };

    const sentimentTotal = cur.sentiment.positive + cur.sentiment.neutral + cur.sentiment.negative || 1;
    const prevSentTotal =
      prev.sentiment.positive + prev.sentiment.neutral + prev.sentiment.negative || 1;

    const sentimentPct = {
      positive: Math.round((cur.sentiment.positive / sentimentTotal) * 100),
      neutral: Math.round((cur.sentiment.neutral / sentimentTotal) * 100),
      negative: Math.round((cur.sentiment.negative / sentimentTotal) * 100),
    };

    const prevPosPct = Math.round((prev.sentiment.positive / prevSentTotal) * 100);

    const byPageOut = pageId ? null : byPage;
    const selectedPageName =
      pageId && currentRows.length > 0
        ? (typeof asRecord(currentRows[0].metadata)?.pageName === 'string'
            ? (asRecord(currentRows[0].metadata)!.pageName as string)
            : `Kênh #${pageId}`)
        : null;

    return {
      source: 'chat_audits' as const,
      period: { from, to, label: `${formatVnDate(from)} - ${formatVnDate(to)}` },
      previousPeriod: { from: prevFromStr, to: prevToStr },
      selectedPageId: pageId ?? null,
      selectedPageName,
      totalAnalyzed: cur.total,
      avgScore: Math.round(cur.avgScore * 10) / 10,
      intro: pageId && selectedPageName
        ? `Chi tiết kênh «${selectedPageName}» — ${cur.total.toLocaleString('vi-VN')} hội thoại đã chấm (${formatVnDate(from)} - ${formatVnDate(to)})`
        : `AI đã phân tích ${cur.total.toLocaleString('vi-VN')} hội thoại trên ${byPage.summary.total} kênh (${formatVnDate(from)} - ${formatVnDate(to)})`,
      kpis: [
        {
          label: 'Hội thoại đã phân tích',
          value: cur.total.toLocaleString('vi-VN'),
          unit: '',
          change: totalChange.text,
          changePositive: totalChange.positive,
          sub: `so với ${prev.total.toLocaleString('vi-VN')} kỳ trước`,
        },
        {
          label: 'Vấn đề rủi ro',
          value: String(cur.riskCount),
          unit: ' hội thoại',
          change: riskChange.text,
          changePositive: !riskChange.positive,
          sub: 'điểm thấp / tiêu cực / vi phạm',
        },
        {
          label: 'Xu hướng tăng mạnh',
          value: growing ? growing.label : '—',
          unit: growing ? ` (${growing.count})` : '',
          change: trendingChange.text,
          changePositive: trendingChange.positive,
          sub: growing ? 'từ khóa nổi bật kỳ này' : 'chưa đủ dữ liệu',
        },
        {
          label: 'Hội thoại bất thường',
          value: String(cur.abnormalCount),
          unit: ' case',
          change: abnormalChange.text,
          changePositive: !abnormalChange.positive,
          sub: `điểm < 40 hoặc urgency cao`,
        },
      ],
      customerConcerns: this.buildConcernDonut(cur.keywords, cur.total),
      closeRateFactors: this.buildCloseFactors(cur.strengths, cur.weaknesses),
      videoTopics: this.buildVideoTopics(cur.keywords),
      products: this.buildProducts(cur.products, cur.keywords),
      sentiment: {
        ...sentimentPct,
        positiveChange: sentimentPct.positive - prevPosPct,
      },
      adEfficiency: this.buildAdEfficiency(cur.adSources),
      highCloseRate: cur.total > 0 ? Math.round((cur.highClose / cur.total) * 100) : 0,
      lowCloseRate: cur.total > 0 ? Math.round((cur.lowClose / cur.total) * 100) : 0,
      byPage: byPageOut,
      pageDirectory: byPage.all,
      byCountry: [] as { country: string; flag: string; insight: string; closeRate: string }[],
    };
  }
}
