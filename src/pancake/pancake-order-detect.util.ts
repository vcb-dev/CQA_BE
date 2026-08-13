/**
 * Heuristic: phát hiện tín hiệu "đã chốt đơn" từ nội dung chat Pancake (TH/VN/JP/EN).
 * Không OCR ảnh — dựa text xác nhận đơn / mạđ cọc / chuyển khoản thành công.
 */

export type ChatOrderSignal = {
  closed: boolean;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  depositMention: boolean;
  orderSummaryMention: boolean;
  paymentSuccessMention: boolean;
};

const PAYMENT_OK =
  /โอนเงินสำเร็จ|โอนสำเร็จ|ชำระเงินสำเร็จ|payment\s*success|transfer\s*successful|đã\s*chuyển|chuyển\s*khoản\s*thành\s*công|入金確認|振込完了|決済完了/i;

const DEPOSIT =
  /มัดจำ|เงินมัดจำ|รับเงินมัดจำ|đặt\s*cọc|đã\s*nhận\s*(tiền\s*)?cọc|cọc\s*\d|deposit|手付|内金/i;

const ORDER_SUMMARY =
  /รายละเอียดการสั่งซื้อ|ยอดรวม|ยอดที่ต้องชำระ|เมื่อได้รับสินค้า|ขอบคุณสำหรับคำสั่งซื้อ|chi\s*tiết\s*đơn|tổng\s*(tiền|cộng)|còn\s*phải\s*thanh\s*toán|cod|thu\s*hộ|ご注文内容|合計|残金|代引き/i;

const ORDER_CONFIRM =
  /จะรีบผลิต|ดำเนินการผลิต|จัดส่ง|giao\s*hàng|sản\s*xuất|shipping|ship\s*to\s*you|発送|製作に入り/i;

const CLOSED_COMBO_SHOP =
  /รับเงินมัดจำ|đã\s*nhận\s*(tiền\s*)?cọc|deposit\s*(received|of)|手付金を|内金を/i;

export function detectOrderClosedFromTexts(texts: Array<string | null | undefined>): ChatOrderSignal {
  const blob = texts.filter(Boolean).join('\n');
  const reasons: string[] = [];
  const paymentSuccessMention = PAYMENT_OK.test(blob);
  const depositMention = DEPOSIT.test(blob);
  const orderSummaryMention = ORDER_SUMMARY.test(blob);
  const confirmMention = ORDER_CONFIRM.test(blob);
  const shopClosedPhrase = CLOSED_COMBO_SHOP.test(blob);

  if (paymentSuccessMention) reasons.push('payment_success');
  if (depositMention) reasons.push('deposit');
  if (orderSummaryMention) reasons.push('order_summary');
  if (confirmMention) reasons.push('fulfillment_confirm');
  if (shopClosedPhrase) reasons.push('shop_deposit_ack');

  // High: shop xác nhận đơn + (cọc hoặc tổng tiền) — đúng case HuyK trong ảnh
  if (orderSummaryMention && (depositMention || shopClosedPhrase || paymentSuccessMention)) {
    return {
      closed: true,
      confidence: 'high',
      reasons,
      depositMention,
      orderSummaryMention,
      paymentSuccessMention,
    };
  }

  // High: phiếu chuyển khoản thành công + shop xác nhận sản xuất/giao
  if (paymentSuccessMention && (confirmMention || depositMention || orderSummaryMention)) {
    return {
      closed: true,
      confidence: 'high',
      reasons,
      depositMention,
      orderSummaryMention,
      paymentSuccessMention,
    };
  }

  // Medium: có cả cọc + xác nhận giao/sản xuất
  if (depositMention && confirmMention) {
    return {
      closed: true,
      confidence: 'medium',
      reasons,
      depositMention,
      orderSummaryMention,
      paymentSuccessMention,
    };
  }

  return {
    closed: false,
    confidence: 'low',
    reasons,
    depositMention,
    orderSummaryMention,
    paymentSuccessMention,
  };
}
