/** Extract phone-like strings from free text (VN + international). */

const PHONE_RE =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{1,4})?/g;

function normalizePhoneCandidate(raw: string): string | null {
  const p = raw.replace(/[^\d+]/g, '');
  if (!p) return null;
  const normalized = p.startsWith('00') ? `+${p.slice(2)}` : p;
  const digits = normalized.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return normalized;
}

export function extractPhonesFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const raw = text.match(PHONE_RE) ?? [];
  const cleaned = raw
    .map((p) => normalizePhoneCandidate(p))
    .filter((p): p is string => Boolean(p));
  return [...new Set(cleaned)];
}

/** Collect phones from Pancake customer / conversation payload fields. */
export function collectPhonesFromPancakeRaw(
  raw: Record<string, unknown> | null | undefined,
): string[] {
  if (!raw) return [];
  const found: string[] = [];

  const push = (v: unknown) => {
    if (v == null) return;
    if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v).trim();
      if (!s) return;
      const normalized = normalizePhoneCandidate(s) || (s.replace(/\D/g, '').length >= 9 ? s : null);
      if (normalized) found.push(normalized);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) push(item);
      return;
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      push(o.phone ?? o.phone_number ?? o.number ?? o.value ?? o.global_id);
    }
  };

  push(raw.phone);
  push(raw.phone_number);
  push(raw.global_id);
  push(raw.phone_numbers);
  push(raw.recent_phone_numbers);
  push(raw._phones);

  return [...new Set(found)];
}

export function extractPhonesFromMessages(
  messages: Array<{
    message?: string | null;
    text?: string | null;
    content?: string | null;
    raw?: Record<string, unknown>;
  }>,
): string[] {
  const found: string[] = [];
  for (const m of messages) {
    const text = m.message ?? m.text ?? m.content ?? '';
    found.push(...extractPhonesFromText(text));
    if (m.raw) {
      found.push(...collectPhonesFromPancakeRaw(m.raw));
      const phoneInfo = m.raw.phone_info;
      if (phoneInfo != null) {
        found.push(...collectPhonesFromPancakeRaw({ phone_numbers: phoneInfo as unknown }));
      }
    }
  }
  return [...new Set(found)];
}

/** Heuristic địa chỉ từ ghi chú / tin nhắn (VN + TH + JP + text tự do). */
export function extractAddressFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const cleaned = stripHtml(text).replace(/\s+/g, ' ').trim();
  if (cleaned.length < 8) return null;
  const patterns = [
    /(?:địa\s*chỉ|dia\s*chi|address|shipping\s*address|ที่อยู่|住所|送付先|配送先)\s*[:：\-–]?\s*(.+)/i,
    /(?:〒\s*\d{3}-?\d{4}[^\n]{5,120})/,
    /(?:số\s+\d+[^\n,]{8,100})/i,
    /(?:\d{1,4}\/\d+[^\n,]{6,100})/,
  ];
  for (const re of patterns) {
    const m = cleaned.match(re);
    if (m?.[0]) {
      const hit = (m[1] || m[0]).trim();
      if (hit.length >= 8 && hit.length <= 240) return hit;
    }
  }
  return null;
}

function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function joinAddressParts(o: Record<string, unknown>): string | null {
  const parts = [
    o.full_name,
    o.name,
    o.phone,
    o.phone_number,
    o.address,
    o.full_address,
    o.street,
    o.street_address,
    o.address1,
    o.address2,
    o.ward,
    o.commune,
    o.district,
    o.city,
    o.province,
    o.state,
    o.post_code,
    o.postal_code,
    o.zip,
    o.country,
  ]
    .map((x) => (x != null ? String(x).trim() : ''))
    .filter(Boolean);
  // Bỏ trùng họ tên/SĐT nếu chỉ còn địa chỉ thuần — vẫn join đủ vì CRM cần 1 dòng giao hàng
  if (!parts.length) return null;
  // Nếu chỉ có phone/name mà không có phần địa chỉ thật → bỏ
  const hasPlace = [
    o.address,
    o.full_address,
    o.street,
    o.street_address,
    o.address1,
    o.ward,
    o.district,
    o.city,
    o.province,
    o.state,
    o.post_code,
    o.postal_code,
  ].some((x) => x != null && String(x).trim());
  if (!hasPlace) return null;
  return [...new Set(parts)].join(', ');
}

function extractFromAddressValue(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim()) {
    const s = v.trim();
    return s.length >= 5 ? s : null;
  }
  if (typeof v === 'object') {
    return joinAddressParts(v as Record<string, unknown>);
  }
  return null;
}

/**
 * Địa chỉ từ profile Pancake / đơn (recent_orders) / lives_in / notes.
 * Nhiều page trả recent_orders=null — khi đó chỉ còn notes / chat / lives_in.
 */
export function collectAddressFromPancakeRaw(
  raw: Record<string, unknown> | null | undefined,
): string | null {
  if (!raw) return null;

  const directKeys = [
    'address',
    'shipping_address',
    'billing_address',
    'full_address',
    'customer_address',
    'delivery_address',
    'ship_address',
  ];
  for (const k of directKeys) {
    const hit = extractFromAddressValue(raw[k]);
    if (hit) return hit;
  }

  const location = raw.location;
  if (location && typeof location === 'object') {
    const hit = extractFromAddressValue(location);
    if (hit) return hit;
  }

  if (typeof raw.lives_in === 'string' && raw.lives_in.trim().length >= 3) {
    return raw.lives_in.trim();
  }

  const orderBags = [raw.recent_orders, raw.orders, raw.last_orders];
  for (const bag of orderBags) {
    if (!Array.isArray(bag)) continue;
    for (const order of bag) {
      if (!order || typeof order !== 'object') continue;
      const o = order as Record<string, unknown>;
      for (const k of [
        'shipping_address',
        'shipping_info',
        'address',
        'customer_address',
        'billing_address',
        'delivery_address',
      ]) {
        const hit = extractFromAddressValue(o[k]);
        if (hit) return hit;
      }
      // Một số payload flatten field tỉnh/thành ngay trên order
      const flat = joinAddressParts(o);
      if (flat) return flat;
    }
  }

  if (typeof raw.notes === 'string') {
    const fromNotes = extractAddressFromText(raw.notes);
    if (fromNotes) return fromNotes;
  }

  return null;
}
