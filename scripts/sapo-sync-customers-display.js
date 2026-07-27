/**
 * Sync Sapo customers → sapo_customers (display table).
 * Fast path: skip existing sapo_id + createMany batches.
 * Usage: node scripts/sapo-sync-customers-display.js
 * Env: SAPO_SYNC_UPDATE=1 để cập nhật lại bản đã có (chậm hơn).
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

const FORCE_UPDATE = process.env.SAPO_SYNC_UPDATE === '1';
const BATCH_SIZE = 100;

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

function customerRow(raw) {
  const addr = raw.default_address || (raw.addresses || [])[0] || {};
  const firstName = raw.first_name?.trim() || null;
  const lastName = raw.last_name?.trim() || null;
  return {
    sapoId: BigInt(raw.id),
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

  const existing = new Set(
    (await prisma.sapoCustomer.findMany({ select: { sapoId: true } })).map((r) =>
      Number(r.sapoId),
    ),
  );
  log(
    JSON.stringify({
      host,
      existing: existing.size,
      forceUpdate: FORCE_UPDATE,
    }),
  );

  let fetched = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  await fetchSapoListPages({
    host,
    auth,
    path: '/admin/customers.json',
    rootKey: 'customers',
    delayMs: 20,
    dateCursor: 'min',
    onPage: async ({ batch, page, window }) => {
      await ensureWritable(prisma);
      fetched += batch.length;

      const toInsert = [];
      for (const raw of batch) {
        if (!raw?.id) continue;
        if (!FORCE_UPDATE && existing.has(raw.id)) {
          skipped++;
          continue;
        }
        if (FORCE_UPDATE && existing.has(raw.id)) {
          try {
            const row = customerRow(raw);
            const { sapoId, ...update } = row;
            await prisma.sapoCustomer.update({ where: { sapoId }, data: update });
            inserted++;
          } catch (e) {
            failed++;
            if (failed <= 10) log(JSON.stringify({ fail: raw.id, ...errInfo(e) }));
          }
          continue;
        }
        toInsert.push(customerRow(raw));
      }

      for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
        const chunk = toInsert.slice(i, i + BATCH_SIZE);
        try {
          const res = await prisma.sapoCustomer.createMany({
            data: chunk,
            skipDuplicates: true,
          });
          inserted += res.count;
          for (const row of chunk) existing.add(Number(row.sapoId));
        } catch (e) {
          // fallback từng dòng nếu batch lỗi
          for (const row of chunk) {
            try {
              await prisma.sapoCustomer.create({ data: row });
              existing.add(Number(row.sapoId));
              inserted++;
            } catch (e2) {
              if (e2.code === 'P2002') {
                existing.add(Number(row.sapoId));
                skipped++;
              } else {
                failed++;
                if (failed <= 20) log(JSON.stringify({ fail: Number(row.sapoId), ...errInfo(e2) }));
              }
            }
          }
        }
      }

      log(
        JSON.stringify({
          page,
          window,
          fetched,
          inserted,
          skipped,
          failed,
          known: existing.size,
        }),
      );
    },
  });

  const dbCount = await prisma.sapoCustomer.count();
  log(JSON.stringify({ done: true, fetched, inserted, skipped, failed, dbCount }));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
