/**
 * Sync Sapo customers → sapo_customers (display table).
 * Usage: node scripts/sapo-sync-customers-display.js
 */
const { Prisma } = require('@prisma/client');
const {
  log,
  createWritablePrisma,
  ensureWritable,
  sapoAuth,
  sapoHost,
  errInfo,
  fetchSapoListPages,
} = require('./lib/sapo-sync-common');

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}

function tagsOf(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

function fullName(first, last) {
  return [first, last].filter(Boolean).join(' ').trim() || null;
}

function customerPayload(raw) {
  const addr = raw.default_address || (raw.addresses || [])[0] || {};
  const firstName = raw.first_name?.trim() || null;
  const lastName = raw.last_name?.trim() || null;
  return {
    email: raw.email?.trim() || null,
    phone: raw.phone?.trim() || null,
    firstName,
    lastName,
    fullName: fullName(firstName, lastName) || addr.name || null,
    gender: raw.gender != null ? String(raw.gender) : null,
    dob: parseDate(raw.dob),
    company: addr.company || null,
    acceptsMarketing: Boolean(raw.accepts_marketing),
    verifiedEmail: Boolean(raw.verified_email),
    state: raw.state || null,
    ordersCount: Number(raw.orders_count || 0),
    totalSpent: new Prisma.Decimal(String(raw.total_spent || 0)),
    lastOrderSapoId: raw.last_order_id ? BigInt(raw.last_order_id) : null,
    lastOrderName: raw.last_order_name || null,
    tags: tagsOf(raw.tags),
    note: raw.note || null,
    addressName: addr.name || null,
    addressPhone: addr.phone || null,
    address1: addr.address1 || null,
    address2: addr.address2 || null,
    ward: addr.ward || null,
    district: addr.district || null,
    city: addr.city || null,
    province: addr.province || null,
    provinceCode: addr.province_code || null,
    districtCode: addr.district_code || null,
    wardCode: addr.ward_code || null,
    country: addr.country || addr.country_name || null,
    countryCode: addr.country_code || null,
    zip: addr.zip || null,
    sapoCreatedAt: parseDate(raw.created_on),
    sapoModifiedAt: parseDate(raw.modified_on),
    syncedAt: new Date(),
  };
}

async function main() {
  const prisma = await createWritablePrisma();
  const host = sapoHost();
  const auth = sapoAuth();

  let fetched = 0;
  let upserted = 0;
  let failed = 0;

  await fetchSapoListPages({
    host,
    auth,
    path: '/admin/customers.json',
    rootKey: 'customers',
    delayMs: 50,
    onPage: async ({ batch, page }) => {
      await ensureWritable(prisma);
      fetched += batch.length;

      for (const raw of batch) {
        const sapoId = raw.id;
        if (!sapoId) continue;
        const payload = customerPayload(raw);
        try {
          await prisma.sapoCustomer.upsert({
            where: { sapoId: BigInt(sapoId) },
            create: { sapoId: BigInt(sapoId), ...payload },
            update: payload,
          });
          upserted++;
        } catch (e) {
          failed++;
          if (failed <= 20 || failed % 50 === 0) {
            log(JSON.stringify({ fail: sapoId, ...errInfo(e) }));
          }
          if (String(e.message || '').includes('read-only')) {
            await ensureWritable(prisma);
          }
        }
      }

      log(JSON.stringify({ page, fetched, upserted, failed }));
    },
  });

  const dbCount = await prisma.sapoCustomer.count();
  log(JSON.stringify({ done: true, fetched, upserted, failed, dbCount }));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
