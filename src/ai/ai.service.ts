import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import http from 'http';
import https from 'https';
import { PrismaService } from '../prisma/prisma.service';
import { User, ChatAudit } from '@prisma/client';
import { buildAnalysisPayloadFromAi } from '../cskh/audit/audit-analytics.util';

function normalizeAuditListField(value: unknown): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const lines = value.map((item) => String(item).trim()).filter(Boolean);
    return lines.length ? lines.join('\n') : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

type AuditActionItem = { issue: string; suggestedReply: string };

function parseActionItemsFromAi(
  actionItemsRaw: unknown,
  violationsRaw: unknown,
  suggestedRaw: unknown,
): AuditActionItem[] {
  const fromPipeText = (text: string): AuditActionItem[] =>
    text
      .split(/\n+/)
      .map((line) => {
        const cleaned = line.replace(/^[\s•+\-–*]+/, '').trim();
        const sep = cleaned.indexOf('||');
        if (sep < 0) return null;
        const issue = cleaned.slice(0, sep).trim();
        const suggestedReply = cleaned.slice(sep + 2).trim();
        if (!issue || !suggestedReply) return null;
        return { issue, suggestedReply };
      })
      .filter((item): item is AuditActionItem => item != null);

  if (typeof actionItemsRaw === 'string' && actionItemsRaw.trim()) {
    const parsed = fromPipeText(actionItemsRaw);
    if (parsed.length) return parsed;
  }

  if (Array.isArray(actionItemsRaw)) {
    const parsed = actionItemsRaw
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const row = item as Record<string, unknown>;
        const issue = String(row.issue ?? row.violation ?? '').trim();
        const suggestedReply = String(row.suggested_reply ?? row.suggestedReply ?? '').trim();
        if (!issue || !suggestedReply) return null;
        return { issue, suggestedReply };
      })
      .filter((item): item is AuditActionItem => item != null);
    if (parsed.length) return parsed;
  }

  const violationLines = normalizeAuditListField(violationsRaw)?.split(/\n+/).filter(Boolean) ?? [];
  const suggestionLines =
    normalizeAuditListField(suggestedRaw)?.split(/\n+/).filter(Boolean) ?? [];
  if (violationLines.length && suggestionLines.length) {
    const count = Math.max(violationLines.length, suggestionLines.length);
    return Array.from({ length: count }, (_, i) => ({
      issue: violationLines[i] ?? violationLines[violationLines.length - 1] ?? 'Cần cải thiện',
      suggestedReply:
        suggestionLines[i] ?? suggestionLines[suggestionLines.length - 1] ?? '',
    })).filter((item) => item.suggestedReply);
  }

  if (suggestionLines.length) {
    return suggestionLines.map((suggestedReply, i) => ({
      issue: violationLines[i] ?? `Gợi ý ${i + 1}`,
      suggestedReply,
    }));
  }

  return [];
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly aiBaseUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
  private readonly auditAiTimeoutMs = Number(process.env.CSKH_AUDIT_AI_TIMEOUT_MS || 120_000);
  private readonly aiHttp = axios.create({
    timeout: this.auditAiTimeoutMs,
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 64 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 64 }),
  });
  /** Cache userId theo tên NV trong một batch chấm điểm — tránh 1000+ query User. */
  private auditAgentUserCache = new Map<string, number | null>();

  constructor(private readonly prisma: PrismaService) {}

  resetAuditBatchCaches() {
    this.auditAgentUserCache.clear();
  }

  private async resolveAuditUserId(
    email?: string,
    agentName?: string,
  ): Promise<number | null> {
    const key = (email?.trim().toLowerCase() || agentName?.trim().toLowerCase() || '').trim();
    if (!key || key === 'nhân viên') return null;
    if (this.auditAgentUserCache.has(key)) {
      return this.auditAgentUserCache.get(key) ?? null;
    }
    let user: { id: number } | null = null;
    if (email?.trim()) {
      user = await this.prisma.user.findFirst({
        where: { email: { contains: email.trim(), mode: 'insensitive' } },
        select: { id: true },
      });
    } else if (agentName?.trim() && agentName.trim() !== 'Nhân viên') {
      user = await this.prisma.user.findFirst({
        where: { fullName: { contains: agentName.trim(), mode: 'insensitive' } },
        select: { id: true },
      });
    }
    const id = user?.id ?? null;
    this.auditAgentUserCache.set(key, id);
    return id;
  }

  async getDeepSeekBalance(): Promise<{
    isAvailable?: boolean;
    currency?: string;
    totalBalance?: number;
    grantedBalance?: number;
    toppedUpBalance?: number;
    model?: string;
    error?: boolean;
    message?: string;
  }> {
    try {
      const { data } = await axios.get(`${this.aiBaseUrl}/deepseek/balance`, {
        timeout: 15000,
      });
      if (data?.error) {
        return { error: true, message: String(data.message || 'Không lấy được số dư DeepSeek API') };
      }
      return {
        isAvailable: Boolean(data.is_available),
        currency: String(data.currency || 'USD'),
        totalBalance: Number(data.total_balance) || 0,
        grantedBalance: Number(data.granted_balance) || 0,
        toppedUpBalance: Number(data.topped_up_balance) || 0,
        model: data.model ? String(data.model) : 'deepseek-chat',
      };
    } catch (error: unknown) {
      const err = error as { message?: string };
      this.logger.warn(`DeepSeek balance fetch failed: ${err.message}`);
      return { error: true, message: 'Không lấy được số dư DeepSeek API' };
    }
  }

  async auditChat(data: {
    transcript: unknown;
    /** Bản rút gọn gửi model — DB vẫn lưu `transcript` đầy đủ. */
    aiTranscript?: unknown;
    agentName?: string;
    email?: string;
    customerName?: string;
    channel?: string;
    noReply?: boolean;
    metadata?: Record<string, unknown>;
  }) {
    try {
      this.logger.log(`Sending chat transcript to AI service for audit... noReply=${data.noReply}`);
      const response = await this.aiHttp.post(`${this.aiBaseUrl}/audit`, {
        transcript: data.aiTranscript ?? data.transcript,
        no_reply: data.noReply || false,
        agent_name: data.agentName || null,
        customer_name: data.customerName || null,
      });

      const auditResult = response.data;

      type TokenUsage = {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        model?: string;
      };
      const tokenUsage = (auditResult.token_usage as TokenUsage | undefined) ?? null;

      const transcriptArr = Array.isArray(data.transcript) ? data.transcript : [];
      const hasStaffInTranscript = transcriptArr.some(
        (line) => line && typeof line === 'object' && (line as { sender?: string }).sender === 'Staff',
      );
      const forceZero = Boolean(data.noReply) || !hasStaffInTranscript;
      const pageName = String(data.metadata?.pageName || '');

      const isGenericCustomer = (n?: string | null) =>
        !n?.trim() || n.trim() === 'Khách hàng' || /^facebook user$/i.test(n.trim());

      const isGenericAgent = (n?: string | null) => {
        if (!n?.trim() || n.trim() === 'Nhân viên' || n.trim() === 'Page CSKH') return true;
        if (pageName && n.trim().toLowerCase() === pageName.toLowerCase()) return true;
        return n.trim().length > 45;
      };

      const pickCustomer = (...sources: (string | null | undefined)[]) => {
        for (const s of sources) {
          if (s?.trim() && !isGenericCustomer(s)) return s.trim();
        }
        return 'Khách hàng';
      };

      const pickAgent = (...sources: (string | null | undefined)[]) => {
        for (const s of sources) {
          if (s?.trim() && !isGenericAgent(s)) return s.trim();
        }
        return 'Nhân viên';
      };

      const agentFromPageLabel = pageName.includes('-')
        ? (() => {
            const m = pageName.match(/^([^-–—|/]+?)\s[-–—|/]\s+/);
            const candidate = m?.[1]?.trim();
            if (!candidate || candidate.length > 40) return null;
            if (/shop|store|page|official|cửa hàng/i.test(candidate)) return null;
            return candidate;
          })()
        : null;

      const finalCustomerName = pickCustomer(
        data.customerName,
        auditResult.customer_name,
      );
      const finalAgentName = pickAgent(
        data.agentName,
        agentFromPageLabel,
        auditResult.agent_name,
      );

      const userId = await this.resolveAuditUserId(data.email, finalAgentName);

      const actionItems = parseActionItemsFromAi(
        auditResult.action_items,
        auditResult.violations,
        auditResult.suggested_replies,
      );
      const violationsFromItems = actionItems.map((item) => item.issue).join('\n') || null;
      const repliesFromItems = actionItems.map((item) => item.suggestedReply).join('\n') || null;
      const analysis = buildAnalysisPayloadFromAi(
        auditResult as Record<string, unknown>,
        data.transcript,
      );

      const savedAudit = await this.prisma.chatAudit.create({
        data: {
          userId,
          agentName: finalAgentName,
          customerName: finalCustomerName,
          channel: data.channel || 'Facebook Messenger',
          score: forceZero ? 0 : parseInt(auditResult.score) || 0,
          feedback: auditResult.feedback,
          transcript: data.transcript as any,
          metadata: {
            originalAgentName: data.agentName,
            originalCustomerName: data.customerName,
            actionItems,
            suggestedReplies:
              repliesFromItems ?? normalizeAuditListField(auditResult.suggested_replies),
            violations: violationsFromItems ?? normalizeAuditListField(auditResult.violations),
            tokenUsage,
            criteriaScores: analysis.criteriaScores,
            strengths: analysis.strengths,
            weaknesses: analysis.weaknesses,
            keywords: analysis.keywords,
            sentiment: analysis.sentiment,
            tags: analysis.tags,
            transcriptMetrics: analysis.transcriptMetrics,
            ...(data.metadata || {}),
          } as any,
        },
      });

      return { ...savedAudit, tokenUsage };
    } catch (error: unknown) {
      const err = error as { response?: { data?: unknown }; message?: string; stack?: string };
      const errorMessage = err.response?.data || err.message;
      this.logger.error(`Audit Failed: ${errorMessage}`, err.stack);

      return {
        error: true,
        message: 'AI Service or Database Error',
        detail: errorMessage,
      };
    }
  }

  async analyzeCustomerIntent(data: {
    messages: Array<{ sender: string; text: string }>;
    customerName?: string | null;
  }): Promise<{
    summary: string;
    intentLabel: string;
    topics: string[];
    productMentions: string[];
    urgency: 'low' | 'normal' | 'high';
    suggestedFocus: string;
    suggestedReply: string;
  }> {
    try {
      const { data: result } = await axios.post(
        `${this.aiBaseUrl}/cskh/customer-intent`,
        {
          messages: data.messages,
          customer_name: data.customerName ?? null,
        },
        { timeout: 45_000 },
      );
      const urgencyRaw = String(result.urgency ?? 'normal').toLowerCase();
      const urgency =
        urgencyRaw === 'low' || urgencyRaw === 'high' ? urgencyRaw : ('normal' as const);
      return {
        summary: String(result.summary ?? '').trim() || 'Khách vừa nhắn tin.',
        intentLabel: String(result.intent_label ?? result.intentLabel ?? 'Chưa rõ').trim(),
        topics: Array.isArray(result.topics)
          ? result.topics.map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 8)
          : [],
        productMentions: Array.isArray(result.product_mentions)
          ? result.product_mentions.map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 10)
          : Array.isArray(result.productMentions)
            ? result.productMentions.map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 10)
            : [],
        urgency,
        suggestedFocus: String(result.suggested_focus ?? result.suggestedFocus ?? '').trim(),
        suggestedReply: String(result.suggested_reply ?? result.suggestedReply ?? '').trim(),
      };
    } catch (error: unknown) {
      const err = error as { message?: string };
      this.logger.warn(`Customer intent analysis failed: ${err.message}`);
      return {
        summary: 'Chưa phân tích được tin nhắn mới.',
        intentLabel: 'Chưa rõ',
        topics: [],
        productMentions: [],
        urgency: 'normal',
        suggestedFocus: 'Đọc tin nhắn mới và phản hồi khách.',
        suggestedReply: '',
      };
    }
  }
}
