import type { AuditCriterionScores, AuditTranscriptMetrics } from './audit-analytics.util';

/** Ngưỡng đạt QA trên báo cáo audit (chat_audits) — khớp cskh.service. */
export const CSKH_PASS_SCORE = 70;

/** Ngưỡng đạt QA trên dashboard insight — khớp cskh-insight.service. */
export const CSKH_INSIGHT_PASS_SCORE = 60;

/** Điểm tối đa mỗi tiêu chí (greeting/needs/consult/objection/closing). */
export const CSKH_CRITERION_MAX = 20;

/** SLA phản hồi lần đầu (giây) — vượt mức → cảnh báo tốc độ. */
export const CSKH_FIRST_RESPONSE_SLA_SEC = 300;

export type CskhQualityStatus = 'good' | 'warning' | 'critical' | 'pending';

export type CskhQualityVerdict = {
  ok: boolean;
  status: CskhQualityStatus;
  statusLabel: string;
  score: number;
  pass: boolean;
  reasons: string[];
};

export type PageQualityInput = {
  avgScore: number;
  riskRate: number;
  auditCount?: number;
};

/**
 * Trạng thái kênh theo điểm TB + tỷ lệ rủi ro.
 * Quy tắc lấy từ cskh-insight.service (pageStatus).
 */
export function evaluatePageQualityStatus(
  avgScore: number,
  riskRate: number,
): Exclude<CskhQualityStatus, 'pending'> {
  if (avgScore < 55 || riskRate >= 55) return 'critical';
  if (avgScore < 65 || riskRate >= 35) return 'warning';
  return 'good';
}

export function qualityStatusLabel(status: CskhQualityStatus): string {
  if (status === 'pending') return 'Chưa audit';
  if (status === 'good') return 'Ổn định';
  if (status === 'warning') return 'Cần cải thiện';
  return 'Cần xử lý gấp';
}

/** Hội thoại đạt QA khi score ≥ ngưỡng (mặc định 70). */
export function isAuditPass(score: number, threshold = CSKH_PASS_SCORE): boolean {
  return Number.isFinite(score) && score >= threshold;
}

/** Tổng 5 tiêu chí (0–100). */
export function sumCriteriaScores(scores: AuditCriterionScores): number {
  return (
    scores.greeting + scores.needs + scores.consult + scores.objection + scores.closing
  );
}

/** Tiêu chí yếu (< 50% điểm tối đa). */
export function findWeakCriteria(
  scores: AuditCriterionScores,
  minRatio = 0.5,
): Array<keyof AuditCriterionScores> {
  const min = CSKH_CRITERION_MAX * minRatio;
  return (Object.keys(scores) as Array<keyof AuditCriterionScores>).filter(
    (k) => scores[k] < min,
  );
}

/** Phản hồi lần đầu có trong SLA không. */
export function isFirstResponseWithinSla(
  metrics: Pick<AuditTranscriptMetrics, 'firstResponseSec'> | null | undefined,
  slaSec = CSKH_FIRST_RESPONSE_SLA_SEC,
): boolean | null {
  const sec = metrics?.firstResponseSec;
  if (sec == null || !Number.isFinite(sec)) return null;
  return sec <= slaSec;
}

/**
 * Đánh giá chất lượng 1 cuộc audit CSKH: đạt/không đạt + mức độ + lý do.
 * Pure function — dùng unit test / báo cáo nhanh, không cần AI hay DB.
 */
export function evaluateCskhQuality(input: {
  score: number;
  criteriaScores?: AuditCriterionScores | null;
  transcriptMetrics?: AuditTranscriptMetrics | null;
  passThreshold?: number;
}): CskhQualityVerdict {
  const score = Number(input.score) || 0;
  const threshold = input.passThreshold ?? CSKH_PASS_SCORE;
  const pass = isAuditPass(score, threshold);
  const reasons: string[] = [];

  if (!pass) {
    reasons.push(`Điểm tổng ${score} < ngưỡng đạt ${threshold}`);
  }

  if (input.criteriaScores) {
    const weak = findWeakCriteria(input.criteriaScores);
    if (weak.length) {
      reasons.push(`Tiêu chí yếu: ${weak.join(', ')}`);
    }
  }

  const withinSla = isFirstResponseWithinSla(input.transcriptMetrics);
  if (withinSla === false) {
    const sec = input.transcriptMetrics?.firstResponseSec ?? 0;
    reasons.push(
      `Phản hồi lần đầu ${sec}s vượt SLA ${CSKH_FIRST_RESPONSE_SLA_SEC}s`,
    );
  }

  let status: CskhQualityStatus;
  if (score <= 0 && !input.criteriaScores) {
    status = 'pending';
  } else {
    // SLA chậm coi như riskRate cảnh báo (35+) để không đánh good
    const riskProxy = withinSla === false ? 40 : 0;
    status = evaluatePageQualityStatus(score, riskProxy);
  }

  const ok = pass && status === 'good';

  if (ok && reasons.length === 0) {
    reasons.push('Đạt chuẩn chất lượng CSKH');
  }

  return {
    ok,
    status,
    statusLabel: qualityStatusLabel(status),
    score,
    pass,
    reasons,
  };
}

/**
 * Đánh giá chất lượng theo kênh (avgScore + riskRate).
 * `ok` = trạng thái good.
 */
export function evaluatePageCskhQuality(input: PageQualityInput): CskhQualityVerdict {
  const auditCount = input.auditCount ?? 1;
  if (auditCount <= 0) {
    return {
      ok: false,
      status: 'pending',
      statusLabel: qualityStatusLabel('pending'),
      score: 0,
      pass: false,
      reasons: ['Chưa có dữ liệu audit'],
    };
  }

  const status = evaluatePageQualityStatus(input.avgScore, input.riskRate);
  const pass = isAuditPass(input.avgScore, CSKH_INSIGHT_PASS_SCORE);
  const reasons: string[] = [];

  if (status === 'critical') {
    reasons.push(
      `Kênh critical: avgScore=${input.avgScore}, riskRate=${input.riskRate}%`,
    );
  } else if (status === 'warning') {
    reasons.push(
      `Kênh cần cải thiện: avgScore=${input.avgScore}, riskRate=${input.riskRate}%`,
    );
  } else {
    reasons.push('Chất lượng kênh ổn định');
  }

  return {
    ok: status === 'good',
    status,
    statusLabel: qualityStatusLabel(status),
    score: input.avgScore,
    pass,
    reasons,
  };
}

/** Nhãn chất lượng theo tỷ lệ đạt QA (ads efficiency). */
export function qualityLabelFromPassRate(
  passRate: number,
): 'Tốt' | 'Khá' | 'Cần cải thiện' {
  if (passRate >= 0.7) return 'Tốt';
  if (passRate >= 0.5) return 'Khá';
  return 'Cần cải thiện';
}
