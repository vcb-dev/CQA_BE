import {
  CSKH_FIRST_RESPONSE_SLA_SEC,
  CSKH_PASS_SCORE,
  evaluateCskhQuality,
  evaluatePageCskhQuality,
  evaluatePageQualityStatus,
  findWeakCriteria,
  isAuditPass,
  isFirstResponseWithinSla,
  qualityLabelFromPassRate,
  qualityStatusLabel,
  sumCriteriaScores,
} from '../../../src/cskh/audit/cskh-quality.util';
import {
  computeTranscriptMetrics,
  parseCriteriaScoresFromAi,
} from '../../../src/cskh/audit/audit-analytics.util';

describe('CSKH quality — đánh giá chất lượng chăm sóc khách hàng', () => {
  describe('isAuditPass', () => {
    it('đạt khi score ≥ 70', () => {
      expect(isAuditPass(70)).toBe(true);
      expect(isAuditPass(100)).toBe(true);
      expect(isAuditPass(69)).toBe(false);
      expect(isAuditPass(CSKH_PASS_SCORE)).toBe(true);
    });
  });

  describe('evaluatePageQualityStatus', () => {
    it('good khi điểm cao và rủi ro thấp', () => {
      expect(evaluatePageQualityStatus(80, 10)).toBe('good');
    });

    it('warning khi điểm 55–64 hoặc risk ≥ 35', () => {
      expect(evaluatePageQualityStatus(60, 10)).toBe('warning');
      expect(evaluatePageQualityStatus(80, 35)).toBe('warning');
    });

    it('critical khi điểm < 55 hoặc risk ≥ 55', () => {
      expect(evaluatePageQualityStatus(50, 10)).toBe('critical');
      expect(evaluatePageQualityStatus(90, 55)).toBe('critical');
    });
  });

  describe('qualityStatusLabel', () => {
    it('map đúng nhãn tiếng Việt', () => {
      expect(qualityStatusLabel('good')).toBe('Ổn định');
      expect(qualityStatusLabel('warning')).toBe('Cần cải thiện');
      expect(qualityStatusLabel('critical')).toBe('Cần xử lý gấp');
      expect(qualityStatusLabel('pending')).toBe('Chưa audit');
    });
  });

  describe('criteria helpers', () => {
    const strong = {
      greeting: 18,
      needs: 16,
      consult: 17,
      objection: 15,
      closing: 14,
    };

    const weakClosing = {
      greeting: 16,
      needs: 15,
      consult: 14,
      objection: 12,
      closing: 5,
    };

    it('cộng tổng 5 tiêu chí', () => {
      expect(sumCriteriaScores(strong)).toBe(80);
    });

    it('phát hiện tiêu chí yếu', () => {
      expect(findWeakCriteria(weakClosing)).toEqual(['closing']);
      expect(findWeakCriteria(strong)).toEqual([]);
    });
  });

  describe('SLA phản hồi lần đầu', () => {
    it('null khi chưa đo được', () => {
      expect(isFirstResponseWithinSla(null)).toBeNull();
      expect(isFirstResponseWithinSla({ firstResponseSec: null })).toBeNull();
    });

    it('trong / ngoài SLA', () => {
      expect(
        isFirstResponseWithinSla({ firstResponseSec: CSKH_FIRST_RESPONSE_SLA_SEC }),
      ).toBe(true);
      expect(isFirstResponseWithinSla({ firstResponseSec: 301 })).toBe(false);
    });
  });

  describe('evaluateCskhQuality — cuộc hội thoại', () => {
    it('ok=true khi điểm cao, tiêu chí ổn, phản hồi nhanh', () => {
      const verdict = evaluateCskhQuality({
        score: 85,
        criteriaScores: {
          greeting: 18,
          needs: 17,
          consult: 16,
          objection: 17,
          closing: 17,
        },
        transcriptMetrics: {
          firstResponseSec: 45,
          staffReplies: 4,
          customerMessages: 5,
          proactivePct: 44,
        },
      });

      expect(verdict.ok).toBe(true);
      expect(verdict.pass).toBe(true);
      expect(verdict.status).toBe('good');
      expect(verdict.statusLabel).toBe('Ổn định');
      expect(verdict.reasons).toContain('Đạt chuẩn chất lượng CSKH');
    });

    it('không đạt khi điểm dưới ngưỡng', () => {
      const verdict = evaluateCskhQuality({ score: 55 });

      expect(verdict.ok).toBe(false);
      expect(verdict.pass).toBe(false);
      expect(verdict.status).toBe('warning');
      expect(verdict.reasons[0]).toMatch(/< ngưỡng đạt 70/);
    });

    it('critical khi điểm rất thấp', () => {
      const verdict = evaluateCskhQuality({ score: 40 });
      expect(verdict.status).toBe('critical');
      expect(verdict.statusLabel).toBe('Cần xử lý gấp');
      expect(verdict.ok).toBe(false);
    });

    it('cảnh báo khi SLA phản hồi chậm dù điểm cao', () => {
      const verdict = evaluateCskhQuality({
        score: 88,
        transcriptMetrics: {
          firstResponseSec: 600,
          staffReplies: 3,
          customerMessages: 3,
          proactivePct: 50,
        },
      });

      expect(verdict.pass).toBe(true);
      expect(verdict.ok).toBe(false);
      expect(verdict.status).toBe('warning');
      expect(verdict.reasons.some((r) => r.includes('SLA'))).toBe(true);
    });

    it('pending khi chưa có điểm audit', () => {
      const verdict = evaluateCskhQuality({ score: 0 });
      expect(verdict.status).toBe('pending');
      expect(verdict.ok).toBe(false);
    });

    it('ghi nhận tiêu chí yếu trong reasons', () => {
      const verdict = evaluateCskhQuality({
        score: 72,
        criteriaScores: {
          greeting: 18,
          needs: 16,
          consult: 15,
          objection: 14,
          closing: 4,
        },
      });

      expect(verdict.pass).toBe(true);
      expect(verdict.reasons.some((r) => r.includes('closing'))).toBe(true);
    });
  });

  describe('evaluatePageCskhQuality — theo kênh', () => {
    it('ổn định khi avg cao và risk thấp', () => {
      const v = evaluatePageCskhQuality({ avgScore: 78, riskRate: 12, auditCount: 20 });
      expect(v.ok).toBe(true);
      expect(v.status).toBe('good');
      expect(v.reasons[0]).toBe('Chất lượng kênh ổn định');
    });

    it('pending khi chưa có audit', () => {
      const v = evaluatePageCskhQuality({ avgScore: 0, riskRate: 0, auditCount: 0 });
      expect(v.status).toBe('pending');
      expect(v.ok).toBe(false);
    });

    it('critical khi riskRate cao', () => {
      const v = evaluatePageCskhQuality({ avgScore: 70, riskRate: 60 });
      expect(v.status).toBe('critical');
      expect(v.ok).toBe(false);
    });
  });

  describe('qualityLabelFromPassRate', () => {
    it('map Tốt / Khá / Cần cải thiện', () => {
      expect(qualityLabelFromPassRate(0.8)).toBe('Tốt');
      expect(qualityLabelFromPassRate(0.5)).toBe('Khá');
      expect(qualityLabelFromPassRate(0.3)).toBe('Cần cải thiện');
    });
  });

  describe('tích hợp transcript + AI criteria → đánh giá chất lượng', () => {
    it('đo firstResponse từ transcript rồi đánh giá', () => {
      const metrics = computeTranscriptMetrics([
        {
          sender: 'Khách',
          text: 'Shop ơi còn hàng không?',
          timestamp: '2026-07-21T10:00:00.000Z',
        },
        {
          sender: 'Staff',
          text: 'Dạ còn ạ, em gửi mẫu nhé',
          timestamp: '2026-07-21T10:01:30.000Z',
        },
      ]);

      expect(metrics.firstResponseSec).toBe(90);
      expect(isFirstResponseWithinSla(metrics)).toBe(true);

      const criteria = parseCriteriaScoresFromAi({
        criteriaScores: {
          greeting: 18,
          needs: 17,
          consult: 16,
          objection: 15,
          closing: 16,
        },
      });

      const verdict = evaluateCskhQuality({
        score: 82,
        criteriaScores: criteria,
        transcriptMetrics: metrics,
      });

      expect(verdict.ok).toBe(true);
      expect(verdict.status).toBe('good');
    });

    it('phát hiện CSKH chậm trả lời khách', () => {
      const metrics = computeTranscriptMetrics([
        {
          sender: 'Khách',
          text: 'Cho mình hỏi giá',
          timestamp: '2026-07-21T08:00:00.000Z',
        },
        {
          sender: 'Staff',
          text: 'Dạ giá này ạ',
          timestamp: '2026-07-21T08:20:00.000Z',
        },
      ]);

      expect(metrics.firstResponseSec).toBe(1200);

      const verdict = evaluateCskhQuality({
        score: 75,
        transcriptMetrics: metrics,
      });

      expect(verdict.ok).toBe(false);
      expect(verdict.status).toBe('warning');
    });
  });
});
