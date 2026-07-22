/**
 * Sync Sapo customers → sapo_customers (bảng hiển thị, cột tách sẵn).
 * Usage: node scripts/sapo-sync-customers-display.js
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { PrismaClient, Prisma } = require('@prisma/client');

function loadEnv() {
  const file = path.resolve(__dirname, '../.env');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();
// Pooler transaction mode thường read-only — ưu tiên DIRECT_URL khi sync ghi.
if (process.env.DIRECT_URL) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

function hostOf(store) {
  const s = (store || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return s.includes('mysapo.net') ? s : `${s}.mysapo.net`;
}

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}

function tagsOf(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === 'string')
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

function fullName(first, last) {
  return [first, last].filter(Boolean).join(' ').trim() || null;
}

async function main() {
  const prisma = new PrismaClient();
  await prisma.$executeRawUnsafe('SET default_transaction_read_only = off');
  await prisma.$executeRawUnsafe('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');
  const host = hostOf(process.env.SAPO_STORE);
  const auth = {
    username: process.env.SAPO_API_KEY || process.env.SAPO_PRIVATE_API_KEY,
    password: process.env.SAPO_API_SECRET || process.env.SAPO_PRIVATE_API_SECRET,
  };

  let fetched = 0;
  let upserted = 0;

  for (let page = 1; page <= 500; page++) {
    const { data } = await axios.get(`https://${host}/admin/customers.json`, {
      auth,
      params: { limit: 250, page },
      timeout: 90_000,
    });
    const batch = data.customers || [];
    if (!batch.length) break;
    fetched += batch.length;

    for (const raw of batch) {
      const sapoId = raw.id;
      if (!sapoId) continue;
      const addr = raw.default_address || (raw.addresses || [])[0] || {};
      const firstName = raw.first_name?.trim() || null;
      const lastName = raw.last_name?.trim() || null;

      await prisma.sapoCustomer.upsert({
        where: { sapoId: BigInt(sapoId) },
        create: {
          sapoId: BigInt(sapoId),
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
        },
        update: {
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
        },
      });
      upserted++;
    }

    console.log(JSON.stringify({ page, fetched, upserted }));
    if (batch.length < 250) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(JSON.stringify({ done: true, fetched, upserted }));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
