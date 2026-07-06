/** Tính metrics hội thoại từ transcript — lưu vào metadata lúc audit (không cần AI). */

export type TranscriptLine = {
  sender?: string;
  text?: string;
  timestamp?: string;
  type?: string;
};

/** Giới hạn số dòng gửi AI — transcript đầy đủ vẫn lưu DB. */
export function trimTranscriptForAi(
  transcript: TranscriptLine[],
  maxLines: number,
): TranscriptLine[] {
  const cap = Math.max(20, maxLines);
  if (transcript.length <= cap) return transcript;
  const head = transcript.slice(0, 8);
  const tail = transcript.slice(-(cap - head.length));
  return [...head, { sender: '…', text: `(… ${transcript.length - cap} tin nhắn …)`, timestamp: '' }, ...tail];
}

export type AuditTranscriptMetrics = {
  firstResponseSec: number | null;
  staffReplies: number;
  customerMessages: number;
  proactivePct: number;
};

export type AuditCriterionScores = {
  greeting: number;
  needs: number;
  consult: number;
  objection: number;
  closing: number;
};

export type AuditSentiment = {
  label: string;
  customer: string;
  staff: string;
  tone: 'positive' | 'neutral' | 'negative';
};

export type AuditAnalysisPayload = {
  criteriaScores?: AuditCriterionScores;
  strengths?: string[];
  weaknesses?: string[];
  keywords?: string[];
  sentiment?: AuditSentiment;
  tags?: string[];
  transcriptMetrics?: AuditTranscriptMetrics;
};

const CRITERIA_MAX = 20;

function parseTime(iso?: string | null): number {
  if (!iso) return NaN;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? NaN : t;
}

export function computeTranscriptMetrics(transcript: unknown): AuditTranscriptMetrics {
  const lines = Array.isArray(transcript) ? (transcript as TranscriptLine[]) : [];
  let firstCustomerAt: number | null = null;
  let firstStaffAfter: number | null = null;
  let staffReplies = 0;
  let customerMessages = 0;

  for (const line of lines) {
    const isStaff = line.sender === 'Staff';
    const t = parseTime(line.timestamp);
    if (Number.isNaN(t)) continue;

    if (!isStaff) {
      customerMessages++;
      if (firstCustomerAt == null) firstCustomerAt = t;
    } else {
      staffReplies++;
      if (firstCustomerAt != null && firstStaffAfter == null && t >= firstCustomerAt) {
        firstStaffAfter = t;
      }
    }
  }

  const firstResponseSec =
    firstCustomerAt != null && firstStaffAfter != null
      ? Math.max(0, Math.round((firstStaffAfter - firstCustomerAt) / 1000))
      : null;

  const total = staffReplies + customerMessages;
  const proactivePct = total > 0 ? Math.round((staffReplies / total) * 100) : 0;

  return { firstResponseSec, staffReplies, customerMessages, proactivePct };
}

export function parseAiBulletList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    return text
      .split(/\n+/)
      .map((line) => line.replace(/^[\s•+\-–*]+/, '').trim())
      .filter(Boolean);
  }
  return [];
}

export function parseAiCommaList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

const GENERIC_KEYWORD_STOP = new Set([
  'dạ',
  'ạ',
  'em',
  'anh',
  'chị',
  'bạn',
  'mình',
  'cho',
  'với',
  'này',
  'được',
  'không',
  'có',
  'là',
  'và',
  'của',
  'nha',
  'nhé',
  'ảnh',
  'nhận',
  'hàng',
  'gửi',
  'luôn',
  'còn',
  'khi',
  'chưa',
  'giúp',
  'đeo',
  'lõm',
  'lại',
  'rồi',
  'vậy',
  'nữa',
  'đó',
  'nào',
  'sao',
  'xin',
  'shop',
  'ad',
]);

function isUsefulKeywordPhrase(value: string): boolean {
  const text = value.trim();
  if (text.length < 2) return false;
  const lower = text.toLowerCase();
  if (GENERIC_KEYWORD_STOP.has(lower)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 1 && text.length <= 5 && !/[A-Z0-9]/.test(text)) return false;
  if (words.length === 1 && GENERIC_KEYWORD_STOP.has(words[0]!.toLowerCase())) return false;
  return true;
}

export function sanitizeAuditKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const kw of keywords) {
    const label = kw.trim();
    if (!isUsefulKeywordPhrase(label)) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out.slice(0, 10);
}

function clampScore(n: number, max = CRITERIA_MAX): number {
  return Math.min(max, Math.max(0, Math.round(n)));
}

export function parseCriteriaScoresFromAi(raw: Record<string, unknown>): AuditCriterionScores | undefined {
  const nested = raw.criteria_scores ?? raw.criteriaScores;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const o = nested as Record<string, unknown>;
    return {
      greeting: clampScore(Number(o.greeting ?? o.score_greeting ?? 0)),
      needs: clampScore(Number(o.needs ?? o.score_needs ?? 0)),
      consult: clampScore(Number(o.consult ?? o.score_consult ?? 0)),
      objection: clampScore(Number(o.objection ?? o.score_objection ?? 0)),
      closing: clampScore(Number(o.closing ?? o.score_closing ?? 0)),
    };
  }

  const hasFlat = ['score_greeting', 'score_needs', 'score_consult', 'score_objection', 'score_closing'].some(
    (k) => raw[k] != null && raw[k] !== '',
  );
  if (!hasFlat) return undefined;

  return {
    greeting: clampScore(Number(raw.score_greeting ?? 0)),
    needs: clampScore(Number(raw.score_needs ?? 0)),
    consult: clampScore(Number(raw.score_consult ?? 0)),
    objection: clampScore(Number(raw.score_objection ?? 0)),
    closing: clampScore(Number(raw.score_closing ?? 0)),
  };
}

function normalizeSentimentTone(value: unknown): AuditSentiment['tone'] {
  const t = String(value ?? '').toLowerCase();
  if (t.includes('positive') || t.includes('tích cực')) return 'positive';
  if (t.includes('negative') || t.includes('cần chú ý') || t.includes('tiêu cực')) return 'negative';
  return 'neutral';
}

export function parseSentimentFromAi(raw: Record<string, unknown>): AuditSentiment | undefined {
  const nested = raw.sentiment;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const o = nested as Record<string, unknown>;
    const label = String(o.label ?? o.sentiment_label ?? '').trim();
    const customer = String(o.customer ?? o.sentiment_customer ?? '').trim();
    const staff = String(o.staff ?? o.sentiment_staff ?? '').trim();
    if (!label && !customer && !staff) return undefined;
    return {
      label: label || 'Trung tính',
      customer: customer || '—',
      staff: staff || '—',
      tone: normalizeSentimentTone(o.tone ?? o.sentiment_tone ?? label),
    };
  }

  const label = String(raw.sentiment_label ?? '').trim();
  const customer = String(raw.sentiment_customer ?? '').trim();
  const staff = String(raw.sentiment_staff ?? '').trim();
  if (!label && !customer && !staff) return undefined;

  return {
    label: label || 'Trung tính',
    customer: customer || '—',
    staff: staff || '—',
    tone: normalizeSentimentTone(raw.sentiment_tone ?? label),
  };
}

export function buildAnalysisPayloadFromAi(
  auditResult: Record<string, unknown>,
  transcript: unknown,
): AuditAnalysisPayload {
  return {
    criteriaScores: parseCriteriaScoresFromAi(auditResult),
    strengths: parseAiBulletList(auditResult.strengths),
    weaknesses: parseAiBulletList(auditResult.weaknesses),
    keywords: sanitizeAuditKeywords(parseAiCommaList(auditResult.keywords)),
    sentiment: parseSentimentFromAi(auditResult),
    tags: parseAiCommaList(auditResult.tags),
    transcriptMetrics: computeTranscriptMetrics(transcript),
  };
}
