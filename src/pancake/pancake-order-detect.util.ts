/**
 * Heuristic: phát hiện tín hiệu "đã chốt đơn" từ nội dung chat Pancake (TH/VN/JP/EN).
 * Không OCR ảnh — dựa text xác nhận đơn / đặt cọc / chuyển khoản thành công / thông báo thanh toán.
 */

export type ChatOrderSignal = {
  closed: boolean;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  depositMention: boolean;
  orderSummaryMention: boolean;
  paymentSuccessMention: boolean;
};

/** Phiếu CK / thông báo thanh toán thành công (Pancake/FB payment card, slip text). */
const PAYMENT_OK =
  /โอนเงินสำเร็จ|โอนสำเร็จ|ชำระเงินสำเร็จ|payment\s*success|transfer\s*successful|đã\s*chuyển(\s*khoản)?(\s*thành\s*công)?|chuyển\s*khoản\s*thành\s*công|đã\s*gửi\s*khoản\s*thanh\s*toán|khoản\s*thanh\s*toán\s*trị\s*giá|thanh\s*toán\s*thành\s*công|ส่งการชำระเงิน|ได้ส่ง(การ)?ชำระ|ได้ส่งเงิน|ส่งเงินให้คุณ|ส่งเงินแล้ว|เป็นจำนวน\s*฿|โอนเงินให้คุณ|ชำระเงินแล้ว|paid\s*successfully|payment\s*of|sent you (a )?(payment|money)|sent you.{0,40}฿|入金確認|振込完了|決済完了/i;

const PAYMENT_AMOUNT =
  /(?:฿|THB|บาท|VND|₫|¥|円)\s*[\d.,]+|[\d.,]+\s*(?:฿|THB|บาท|VND|₫|บาทถ้วน)/i;

const DEPOSIT =
  /มัดจำ|เงินมัดจำ|รับเงินมัดจำ|đặt\s*cọc|đã\s*nhận\s*(tiền\s*)?cọc|cọc\s*\d|deposit|手付|内金/i;

const ORDER_SUMMARY =
  /รายละเอียดการสั่งซื้อ|ยอดรวม|ยอดที่ต้องชำระ|เมื่อได้รับสินค้า|ขอบคุณสำหรับคำสั่งซื้อ|ขอบคุณที่(อุดหนุน|สั่งซื้อ|ซื้อ)|chi\s*tiết\s*đơn|tổng\s*(tiền|cộng)|còn\s*phải\s*thanh\s*toán|cod|thu\s*hộ|ご注文内容|合計|残金|代引き/i;

const ORDER_CONFIRM =
  /จะรีบผลิต|ดำเนินการผลิต|จัดส่ง|giao\s*hàng|sản\s*xuất|shipping|ship\s*to\s*you|発送|製作に入り|หวังว่าคุณจะพอใจ|hope\s*you\s*(like|love)|earrings|ต่างหู/i;

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
  const amountMention = PAYMENT_AMOUNT.test(blob);

  if (paymentSuccessMention) reasons.push('payment_success');
  if (depositMention) reasons.push('deposit');
  if (orderSummaryMention) reasons.push('order_summary');
  if (confirmMention) reasons.push('fulfillment_confirm');
  if (shopClosedPhrase) reasons.push('shop_deposit_ack');
  if (amountMention) reasons.push('payment_amount');

  // High: shop xác nhận đơn + (cọc hoặc tổng tiền / CK)
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

  // High: phiếu / thông báo CK thành công + shop xác nhận sản xuất/giao/cảm ơn đơn
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

  // High: có thông báo thanh toán + số tiền (case Pancake "đã gửi khoản thanh toán trị giá ฿100")
  if (paymentSuccessMention && amountMention) {
    return {
      closed: true,
      confidence: 'high',
      reasons,
      depositMention,
      orderSummaryMention,
      paymentSuccessMention,
    };
  }

  // Medium: chỉ thông báo CK/thanh toán thành công (slip / payment card)
  if (paymentSuccessMention) {
    return {
      closed: true,
      confidence: 'medium',
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
