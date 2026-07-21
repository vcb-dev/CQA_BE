/**
 * Copy data Warehouse DB → shared CQA DB.
 * Remap: users (email), branches (code), warehouses (code),
 * products (slug), product_variants (sku).
 *
 * Usage: node scripts/copy-warehouse-to-shared.js [--dry-run]
 */
const { Client } = require('pg');

const SRC =
  process.env.SRC_DATABASE_URL ||
  'postgresql://postgres.vxjwgyvileqmllgeztbu:LuongVD1120@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres';
const DST =
  process.env.DST_DATABASE_URL ||
  'postgresql://postgres.hvhornnujanjingzwjgf:trunghieu2003Hh%40@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres';

const DRY = process.argv.includes('--dry-run');

function client(url) {
  return new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 60_000,
    statement_timeout: 300_000,
  });
}

async function tableCols(c, table) {
  const { rows } = await c.query(
    `
    SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1
    ORDER BY ordinal_position
  `,
    [table],
  );
  return rows;
}

async function hasTable(c, table) {
  const { rows } = await c.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return rows.length > 0;
}

async function resetSeq(c, table, idCol = 'id') {
  const q = await c.query(
    `
    SELECT pg_get_serial_sequence($1, $2) AS seq
  `,
    [`public.${table}`, idCol],
  );
  const seq = q.rows[0]?.seq;
  if (!seq) return;
  await c.query(
    `SELECT setval($1::regclass, COALESCE((SELECT MAX("${idCol}") FROM public."${table}"), 1), true)`,
    [seq],
  );
}

async function upsertByUnique(dst, table, rows, cols, conflictCols, updateCols = []) {
  if (!rows.length) return 0;
  let n = 0;
  for (const row of rows) {
    const vals = cols.map((c) => row[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const conflict = conflictCols.map((c) => `"${c}"`).join(', ');
    let sql = `INSERT INTO public."${table}" (${cols.map((c) => `"${c}"`).join(', ')})
               VALUES (${placeholders})
               ON CONFLICT (${conflict}) DO `;
    if (updateCols.length) {
      sql += `UPDATE SET ${updateCols
        .map((c) => `"${c}" = EXCLUDED."${c}"`)
        .join(', ')}`;
    } else {
      sql += 'NOTHING';
    }
    try {
      const r = await dst.query(sql, vals);
      n += r.rowCount || 0;
    } catch (e) {
      console.error(`  ! ${table} upsert fail:`, e.message);
      throw e;
    }
  }
  return n;
}

async function insertRows(dst, table, rows, cols, { onConflictNothing = false, conflictCols = [] } = {}) {
  if (!rows.length) return 0;
  let n = 0;
  const batchSize = 100;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values = [];
    const placeholders = [];
    let p = 1;
    for (const row of batch) {
      const ph = [];
      for (const col of cols) {
        values.push(row[col]);
        ph.push(`$${p++}`);
      }
      placeholders.push(`(${ph.join(',')})`);
    }
    let sql = `INSERT INTO public."${table}" (${cols.map((c) => `"${c}"`).join(',')})
               VALUES ${placeholders.join(',')}`;
    if (onConflictNothing && conflictCols.length) {
      sql += ` ON CONFLICT (${conflictCols.map((c) => `"${c}"`).join(',')}) DO NOTHING`;
    }
    try {
      const r = await dst.query(sql, values);
      n += r.rowCount || 0;
    } catch (e) {
      // fallback row-by-row
      for (const row of batch) {
        const vals = cols.map((c) => row[c]);
        let one = `INSERT INTO public."${table}" (${cols.map((c) => `"${c}"`).join(',')})
                   VALUES (${cols.map((_, j) => `$${j + 1}`).join(',')})`;
        if (onConflictNothing && conflictCols.length) {
          one += ` ON CONFLICT (${conflictCols.map((c) => `"${c}"`).join(',')}) DO NOTHING`;
        }
        try {
          const r = await dst.query(one, vals);
          n += r.rowCount || 0;
        } catch (e2) {
          console.error(`  ! ${table} row fail:`, e2.message, row.id ?? '');
        }
      }
    }
  }
  return n;
}

function remapRow(row, maps) {
  const out = { ...row };
  if (maps.user && out.user_id != null && maps.user.has(Number(out.user_id))) {
    out.user_id = maps.user.get(Number(out.user_id));
  }
  for (const key of [
    'created_by',
    'assigned_to',
    'received_by',
    'assigned_to_id',
  ]) {
    if (maps.user && out[key] != null && maps.user.has(Number(out[key]))) {
      out[key] = maps.user.get(Number(out[key]));
    }
  }
  if (maps.branch && out.branch_id != null && maps.branch.has(Number(out.branch_id))) {
    out.branch_id = maps.branch.get(Number(out.branch_id));
  }
  if (maps.warehouse && out.warehouse_id != null && maps.warehouse.has(Number(out.warehouse_id))) {
    out.warehouse_id = maps.warehouse.get(Number(out.warehouse_id));
  }
  for (const key of ['from_warehouse_id', 'to_warehouse_id']) {
    if (maps.warehouse && out[key] != null && maps.warehouse.has(Number(out[key]))) {
      out[key] = maps.warehouse.get(Number(out[key]));
    }
  }
  if (maps.product && out.product_id != null && maps.product.has(Number(out.product_id))) {
    out.product_id = maps.product.get(Number(out.product_id));
  }
  if (maps.variant && out.variant_id != null && maps.variant.has(Number(out.variant_id))) {
    out.variant_id = maps.variant.get(Number(out.variant_id));
  }
  if (maps.supplier && out.supplier_id != null && maps.supplier.has(Number(out.supplier_id))) {
    out.supplier_id = maps.supplier.get(Number(out.supplier_id));
  }
  if (maps.customer && out.customer_id != null && maps.customer.has(Number(out.customer_id))) {
    out.customer_id = maps.customer.get(Number(out.customer_id));
  }
  if (maps.role && out.role_id != null && maps.role.has(Number(out.role_id))) {
    out.role_id = maps.role.get(Number(out.role_id));
  }
  if (maps.permission && out.permission_id != null && maps.permission.has(Number(out.permission_id))) {
    out.permission_id = maps.permission.get(Number(out.permission_id));
  }
  if (maps.po && out.purchase_order_id != null && maps.po.has(Number(out.purchase_order_id))) {
    out.purchase_order_id = maps.po.get(Number(out.purchase_order_id));
  }
  if (maps.gr && out.goods_receipt_id != null && maps.gr.has(Number(out.goods_receipt_id))) {
    out.goods_receipt_id = maps.gr.get(Number(out.goods_receipt_id));
  }
  if (maps.stn && out.stock_transfer_id != null && maps.stn.has(Number(out.stock_transfer_id))) {
    out.stock_transfer_id = maps.stn.get(Number(out.stock_transfer_id));
  }
  if (maps.pvn && out.purchase_return_id != null && maps.pvn.has(Number(out.purchase_return_id))) {
    out.purchase_return_id = maps.pvn.get(Number(out.purchase_return_id));
  }
  if (maps.order && out.order_id != null && maps.order.has(Number(out.order_id))) {
    out.order_id = maps.order.get(Number(out.order_id));
  }
  if (maps.orderReturn && out.order_return_id != null && maps.orderReturn.has(Number(out.order_return_id))) {
    out.order_return_id = maps.orderReturn.get(Number(out.order_return_id));
  }
  if (maps.draft && out.draft_order_id != null && maps.draft.has(Number(out.draft_order_id))) {
    out.draft_order_id = maps.draft.get(Number(out.draft_order_id));
  }
  if (maps.conv && out.conversation_id != null && maps.conv.has(Number(out.conversation_id))) {
    out.conversation_id = maps.conv.get(Number(out.conversation_id));
  }
  if (maps.customerGroup && out.customer_group_id != null && maps.customerGroup.has(Number(out.customer_group_id))) {
    out.customer_group_id = maps.customerGroup.get(Number(out.customer_group_id));
  }
  if (maps.priceList && out.price_list_id != null && maps.priceList.has(Number(out.price_list_id))) {
    out.price_list_id = maps.priceList.get(Number(out.price_list_id));
  }
  if (maps.category && out.category_id != null && maps.category.has(Number(out.category_id))) {
    out.category_id = maps.category.get(Number(out.category_id));
  }
  if (maps.option && out.option_id != null && maps.option.has(Number(out.option_id))) {
    out.option_id = maps.option.get(Number(out.option_id));
  }
  return out;
}

async function fetchAll(src, table) {
  const { rows } = await src.query(`SELECT * FROM public."${table}" ORDER BY 1`);
  return rows;
}

async function commonCols(src, dst, table) {
  const sc = await tableCols(src, table);
  const dc = await tableCols(dst, table);
  const dSet = new Set(dc.map((c) => c.column_name));
  return sc.map((c) => c.column_name).filter((n) => dSet.has(n));
}

async function copySimple(src, dst, table, maps, opts = {}) {
  if (!(await hasTable(src, table)) || !(await hasTable(dst, table))) {
    console.log(`SKIP ${table} (missing table)`);
    return;
  }
  const cols = await commonCols(src, dst, table);
  let rows = await fetchAll(src, table);
  if (!rows.length) {
    console.log(`SKIP ${table} (empty)`);
    return;
  }
  rows = rows.map((r) => remapRow(r, maps));

  if (DRY) {
    console.log(`DRY ${table}: would copy ${rows.length} rows, cols=${cols.length}`);
    return;
  }

  // Prefer preserving IDs when free; else remap via insert without id
  const hasId = cols.includes('id');
  let inserted = 0;

  if (opts.conflictCols?.length) {
    inserted = await insertRows(dst, table, rows, cols, {
      onConflictNothing: true,
      conflictCols: opts.conflictCols,
    });
  } else if (hasId && opts.remapId) {
    // insert one-by-one; if id conflict, insert without id and record map
    const idMap = maps[opts.remapId] || new Map();
    maps[opts.remapId] = idMap;
    const colsNoId = cols.filter((c) => c !== 'id');
    for (const row of rows) {
      const oldId = Number(row.id);
      try {
        await dst.query(
          `INSERT INTO public."${table}" (${cols.map((c) => `"${c}"`).join(',')})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
          cols.map((c) => row[c]),
        );
        idMap.set(oldId, oldId);
        inserted++;
      } catch {
        const r = await dst.query(
          `INSERT INTO public."${table}" (${colsNoId.map((c) => `"${c}"`).join(',')})
           VALUES (${colsNoId.map((_, i) => `$${i + 1}`).join(',')})
           RETURNING id`,
          colsNoId.map((c) => row[c]),
        );
        idMap.set(oldId, Number(r.rows[0].id));
        inserted++;
      }
    }
  } else {
    inserted = await insertRows(dst, table, rows, cols, {
      onConflictNothing: Boolean(opts.onConflictNothing),
      conflictCols: opts.conflictCols || (hasId ? ['id'] : []),
    });
  }

  if (hasId) await resetSeq(dst, table, 'id');
  console.log(`OK  ${table}: +${inserted}/${rows.length}`);
}

(async () => {
  console.log(DRY ? '=== DRY RUN ===' : '=== COPY Warehouse → Shared ===');
  const src = client(SRC);
  const dst = client(DST);
  await src.connect();
  await dst.connect();
  // Supabase project may have default_transaction_read_only=on — allow writes this session.
  await dst.query('SET default_transaction_read_only = off');
  await dst.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');

  const maps = {
    user: new Map(),
    branch: new Map(),
    warehouse: new Map(),
    product: new Map(),
    variant: new Map(),
    supplier: new Map(),
    customer: new Map(),
    role: new Map(),
    permission: new Map(),
    po: new Map(),
    gr: new Map(),
    stn: new Map(),
    pvn: new Map(),
    order: new Map(),
    orderReturn: new Map(),
    draft: new Map(),
    conv: new Map(),
    customerGroup: new Map(),
    priceList: new Map(),
    category: new Map(),
    option: new Map(),
  };

  // Không bọc 1 transaction khổng lồ — lỗi 1 bảng không làm mất cả tiến độ.
  try {
    // ── users by email ──
    {
      const srcUsers = await fetchAll(src, 'users');
      const { rows: dstUsers } = await dst.query(`SELECT id, email FROM users`);
      const byEmail = new Map(dstUsers.map((u) => [u.email.toLowerCase(), Number(u.id)]));
      for (const u of srcUsers) {
        const email = (u.email || '').toLowerCase();
        if (byEmail.has(email)) {
          maps.user.set(Number(u.id), byEmail.get(email));
        } else if (!DRY) {
          const cols = await commonCols(src, dst, 'users');
          const colsNoId = cols.filter((c) => c !== 'id');
          const r = await dst.query(
            `INSERT INTO users (${colsNoId.map((c) => `"${c}"`).join(',')})
             VALUES (${colsNoId.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
            colsNoId.map((c) => u[c]),
          );
          maps.user.set(Number(u.id), Number(r.rows[0].id));
          byEmail.set(email, Number(r.rows[0].id));
        } else {
          maps.user.set(Number(u.id), Number(u.id)); // dry placeholder
        }
      }
      console.log(`MAP users: ${[...maps.user.entries()].map(([a, b]) => `${a}→${b}`).join(', ')}`);
      if (!DRY) await resetSeq(dst, 'users');
    }

    // ── branches by code ──
    {
      const srcRows = await fetchAll(src, 'branches');
      const { rows: dstRows } = await dst.query(`SELECT id, code FROM branches`);
      const byCode = new Map(dstRows.map((r) => [r.code, Number(r.id)]));
      for (const row of srcRows) {
        if (byCode.has(row.code)) {
          maps.branch.set(Number(row.id), byCode.get(row.code));
        } else if (!DRY) {
          const cols = await commonCols(src, dst, 'branches');
          try {
            await dst.query(
              `INSERT INTO branches (${cols.map((c) => `"${c}"`).join(',')})
               VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
              cols.map((c) => row[c]),
            );
            maps.branch.set(Number(row.id), Number(row.id));
            byCode.set(row.code, Number(row.id));
          } catch {
            const colsNoId = cols.filter((c) => c !== 'id');
            const r = await dst.query(
              `INSERT INTO branches (${colsNoId.map((c) => `"${c}"`).join(',')})
               VALUES (${colsNoId.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
              colsNoId.map((c) => row[c]),
            );
            maps.branch.set(Number(row.id), Number(r.rows[0].id));
            byCode.set(row.code, Number(r.rows[0].id));
          }
        } else maps.branch.set(Number(row.id), Number(row.id));
      }
      console.log(`MAP branches: ${[...maps.branch.entries()].map(([a, b]) => `${a}→${b}`).join(', ')}`);
      if (!DRY) await resetSeq(dst, 'branches');
    }

    // ── warehouses by code ──
    {
      const srcRows = await fetchAll(src, 'warehouses');
      const { rows: dstRows } = await dst.query(`SELECT id, code FROM warehouses`);
      const byCode = new Map(dstRows.map((r) => [r.code, Number(r.id)]));
      for (const row of srcRows) {
        const mapped = { ...row, branch_id: maps.branch.get(Number(row.branch_id)) ?? row.branch_id };
        if (byCode.has(mapped.code)) {
          maps.warehouse.set(Number(row.id), byCode.get(mapped.code));
        } else if (!DRY) {
          const cols = await commonCols(src, dst, 'warehouses');
          try {
            await dst.query(
              `INSERT INTO warehouses (${cols.map((c) => `"${c}"`).join(',')})
               VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
              cols.map((c) => mapped[c]),
            );
            maps.warehouse.set(Number(row.id), Number(row.id));
            byCode.set(mapped.code, Number(row.id));
          } catch {
            const colsNoId = cols.filter((c) => c !== 'id');
            const r = await dst.query(
              `INSERT INTO warehouses (${colsNoId.map((c) => `"${c}"`).join(',')})
               VALUES (${colsNoId.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
              colsNoId.map((c) => mapped[c]),
            );
            maps.warehouse.set(Number(row.id), Number(r.rows[0].id));
            byCode.set(mapped.code, Number(r.rows[0].id));
          }
        } else maps.warehouse.set(Number(row.id), Number(row.id));
      }
      console.log(`MAP warehouses: ${maps.warehouse.size} entries`);
      if (!DRY) await resetSeq(dst, 'warehouses');
    }

    // ── roles by name ──
    {
      const srcRows = await fetchAll(src, 'roles');
      const { rows: dstRows } = await dst.query(`SELECT id, name FROM roles`).catch(() => ({ rows: [] }));
      const byName = new Map(dstRows.map((r) => [r.name, Number(r.id)]));
      for (const row of srcRows) {
        if (byName.has(row.name)) {
          maps.role.set(Number(row.id), byName.get(row.name));
        } else if (!DRY) {
          const cols = await commonCols(src, dst, 'roles');
          try {
            await dst.query(
              `INSERT INTO roles (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
              cols.map((c) => row[c]),
            );
            maps.role.set(Number(row.id), Number(row.id));
            byName.set(row.name, Number(row.id));
          } catch {
            const colsNoId = cols.filter((c) => c !== 'id');
            const r = await dst.query(
              `INSERT INTO roles (${colsNoId.map((c) => `"${c}"`).join(',')}) VALUES (${colsNoId.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
              colsNoId.map((c) => row[c]),
            );
            maps.role.set(Number(row.id), Number(r.rows[0].id));
            byName.set(row.name, Number(r.rows[0].id));
          }
        } else maps.role.set(Number(row.id), Number(row.id));
      }
      console.log(`MAP roles: ${maps.role.size}`);
      if (!DRY) await resetSeq(dst, 'roles');
    }

    // ── permissions by code/key ──
    {
      const srcRows = await fetchAll(src, 'permissions');
      const dstCols = await tableCols(dst, 'permissions');
      const keyCol = dstCols.some((c) => c.column_name === 'code')
        ? 'code'
        : dstCols.some((c) => c.column_name === 'key')
          ? 'key'
          : 'name';
      const { rows: dstRows } = await dst.query(`SELECT id, "${keyCol}" AS k FROM permissions`);
      const byKey = new Map(dstRows.map((r) => [r.k, Number(r.id)]));
      for (const row of srcRows) {
        const k = row[keyCol];
        if (byKey.has(k)) {
          maps.permission.set(Number(row.id), byKey.get(k));
        } else if (!DRY) {
          const cols = await commonCols(src, dst, 'permissions');
          try {
            await dst.query(
              `INSERT INTO permissions (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
              cols.map((c) => row[c]),
            );
            maps.permission.set(Number(row.id), Number(row.id));
            byKey.set(k, Number(row.id));
          } catch {
            const colsNoId = cols.filter((c) => c !== 'id');
            const r = await dst.query(
              `INSERT INTO permissions (${colsNoId.map((c) => `"${c}"`).join(',')}) VALUES (${colsNoId.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
              colsNoId.map((c) => row[c]),
            );
            maps.permission.set(Number(row.id), Number(r.rows[0].id));
            byKey.set(k, Number(r.rows[0].id));
          }
        } else maps.permission.set(Number(row.id), Number(row.id));
      }
      console.log(`MAP permissions: ${maps.permission.size}`);
      if (!DRY) await resetSeq(dst, 'permissions');
    }

    await copySimple(src, dst, 'role_permissions', maps, {
      conflictCols: ['role_id', 'permission_id'],
    });
    await copySimple(src, dst, 'user_warehouses', maps, {
      conflictCols: ['user_id', 'warehouse_id'],
    });
    await copySimple(src, dst, 'user_warehouse_roles', maps, {
      conflictCols: ['user_id', 'warehouse_id', 'role_id'],
    });
    await copySimple(src, dst, 'user_permission_overrides', maps, { remapId: null, onConflictNothing: true, conflictCols: ['id'] });
    await copySimple(src, dst, 'user_invitations', maps, { onConflictNothing: true, conflictCols: ['id'] });

    // customer_groups
    {
      const srcRows = await fetchAll(src, 'customer_groups');
      for (const row of srcRows) {
        if (DRY) {
          maps.customerGroup.set(Number(row.id), Number(row.id));
          continue;
        }
        const cols = await commonCols(src, dst, 'customer_groups');
        try {
          await dst.query(
            `INSERT INTO customer_groups (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (id) DO NOTHING`,
            cols.map((c) => row[c]),
          );
          maps.customerGroup.set(Number(row.id), Number(row.id));
        } catch {
          const colsNoId = cols.filter((c) => c !== 'id');
          const r = await dst.query(
            `INSERT INTO customer_groups (${colsNoId.map((c) => `"${c}"`).join(',')}) VALUES (${colsNoId.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
            colsNoId.map((c) => row[c]),
          );
          maps.customerGroup.set(Number(row.id), Number(r.rows[0].id));
        }
      }
      if (!DRY) await resetSeq(dst, 'customer_groups');
      console.log(`MAP customer_groups: ${maps.customerGroup.size}`);
    }

    // categories
    {
      const srcRows = await fetchAll(src, 'categories');
      for (const row of srcRows) {
        if (DRY) {
          maps.category.set(Number(row.id), Number(row.id));
          continue;
        }
        const cols = await commonCols(src, dst, 'categories');
        try {
          await dst.query(
            `INSERT INTO categories (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (id) DO NOTHING`,
            cols.map((c) => row[c]),
          );
          const exists = await dst.query(`SELECT id FROM categories WHERE id=$1`, [row.id]);
          if (exists.rows.length) maps.category.set(Number(row.id), Number(row.id));
          else throw new Error('retry');
        } catch {
          const colsNoId = cols.filter((c) => c !== 'id');
          // try by name/slug
          const slugCol = cols.includes('slug') ? 'slug' : null;
          if (slugCol) {
            const ex = await dst.query(`SELECT id FROM categories WHERE slug=$1`, [row.slug]);
            if (ex.rows.length) {
              maps.category.set(Number(row.id), Number(ex.rows[0].id));
              continue;
            }
          }
          const r = await dst.query(
            `INSERT INTO categories (${colsNoId.map((c) => `"${c}"`).join(',')}) VALUES (${colsNoId.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
            colsNoId.map((c) => row[c]),
          );
          maps.category.set(Number(row.id), Number(r.rows[0].id));
        }
      }
      if (!DRY) await resetSeq(dst, 'categories');
      console.log(`MAP categories: ${maps.category.size}`);
    }

    // products by slug
    {
      const srcRows = await fetchAll(src, 'products');
      const { rows: dstRows } = await dst.query(`SELECT id, slug FROM products`);
      const bySlug = new Map(dstRows.map((r) => [r.slug, Number(r.id)]));
      for (const row of srcRows) {
        if (bySlug.has(row.slug)) {
          maps.product.set(Number(row.id), bySlug.get(row.slug));
        } else if (!DRY) {
          const cols = await commonCols(src, dst, 'products');
          try {
            await dst.query(
              `INSERT INTO products (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
              cols.map((c) => row[c]),
            );
            maps.product.set(Number(row.id), Number(row.id));
            bySlug.set(row.slug, Number(row.id));
          } catch {
            const colsNoId = cols.filter((c) => c !== 'id');
            const r = await dst.query(
              `INSERT INTO products (${colsNoId.map((c) => `"${c}"`).join(',')}) VALUES (${colsNoId.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
              colsNoId.map((c) => row[c]),
            );
            maps.product.set(Number(row.id), Number(r.rows[0].id));
            bySlug.set(row.slug, Number(r.rows[0].id));
          }
        } else maps.product.set(Number(row.id), Number(row.id));
      }
      console.log(`MAP products: ${maps.product.size}`);
      if (!DRY) await resetSeq(dst, 'products');
    }

    // product_options
    {
      const srcRows = await fetchAll(src, 'product_options');
      for (const row of srcRows) {
        const mapped = remapRow(row, maps);
        if (DRY) {
          maps.option.set(Number(row.id), Number(row.id));
          continue;
        }
        const cols = await commonCols(src, dst, 'product_options');
        try {
          await dst.query(
            `INSERT INTO product_options (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (id) DO NOTHING`,
            cols.map((c) => mapped[c]),
          );
          maps.option.set(Number(row.id), Number(row.id));
        } catch {
          const colsNoId = cols.filter((c) => c !== 'id');
          const r = await dst.query(
            `INSERT INTO product_options (${colsNoId.map((c) => `"${c}"`).join(',')}) VALUES (${colsNoId.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
            colsNoId.map((c) => mapped[c]),
          );
          maps.option.set(Number(row.id), Number(r.rows[0].id));
        }
      }
      if (!DRY) await resetSeq(dst, 'product_options');
      console.log(`MAP product_options: ${maps.option.size}`);
    }

    // variants by sku
    {
      const srcRows = await fetchAll(src, 'product_variants');
      const { rows: dstRows } = await dst.query(`SELECT id, sku FROM product_variants`);
      const bySku = new Map(dstRows.map((r) => [r.sku, Number(r.id)]));
      for (const row of srcRows) {
        const mapped = remapRow(row, maps);
        if (bySku.has(mapped.sku)) {
          maps.variant.set(Number(row.id), bySku.get(mapped.sku));
        } else if (!DRY) {
          const cols = await commonCols(src, dst, 'product_variants');
          try {
            await dst.query(
              `INSERT INTO product_variants (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
              cols.map((c) => mapped[c]),
            );
            maps.variant.set(Number(row.id), Number(row.id));
            bySku.set(mapped.sku, Number(row.id));
          } catch {
            const colsNoId = cols.filter((c) => c !== 'id');
            const r = await dst.query(
              `INSERT INTO product_variants (${colsNoId.map((c) => `"${c}"`).join(',')}) VALUES (${colsNoId.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
              colsNoId.map((c) => mapped[c]),
            );
            maps.variant.set(Number(row.id), Number(r.rows[0].id));
            bySku.set(mapped.sku, Number(r.rows[0].id));
          }
        } else maps.variant.set(Number(row.id), Number(row.id));
      }
      console.log(`MAP variants: ${maps.variant.size}`);
      if (!DRY) await resetSeq(dst, 'product_variants');
    }

    await copySimple(src, dst, 'variant_option_values', maps, {
      conflictCols: ['variant_id', 'option_id'],
    });
    await copySimple(src, dst, 'product_images', maps, { onConflictNothing: true, conflictCols: ['id'] });
    await copySimple(src, dst, 'product_categories', maps, {
      conflictCols: ['product_id', 'category_id'],
    });
    await copySimple(src, dst, 'product_sales_channels', maps, {
      conflictCols: ['product_id', 'channel'],
    });

    // price_lists
    {
      const srcRows = await fetchAll(src, 'price_lists');
      for (const row of srcRows) {
        if (DRY) {
          maps.priceList.set(Number(row.id), Number(row.id));
          continue;
        }
        const cols = await commonCols(src, dst, 'price_lists');
        try {
          await dst.query(
            `INSERT INTO price_lists (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (id) DO NOTHING`,
            cols.map((c) => row[c]),
          );
          maps.priceList.set(Number(row.id), Number(row.id));
        } catch {
          const colsNoId = cols.filter((c) => c !== 'id');
          const r = await dst.query(
            `INSERT INTO price_lists (${colsNoId.map((c) => `"${c}"`).join(',')}) VALUES (${colsNoId.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
            colsNoId.map((c) => row[c]),
          );
          maps.priceList.set(Number(row.id), Number(r.rows[0].id));
        }
      }
      if (!DRY) await resetSeq(dst, 'price_lists');
    }
    await copySimple(src, dst, 'price_list_items', maps, { onConflictNothing: true, conflictCols: ['id'] });

    // inventory_levels upsert
    {
      const srcRows = (await fetchAll(src, 'inventory_levels')).map((r) => remapRow(r, maps));
      if (!DRY) {
        const cols = await commonCols(src, dst, 'inventory_levels');
        let n = 0;
        for (const row of srcRows) {
          const r = await dst.query(
            `INSERT INTO inventory_levels (${cols.map((c) => `"${c}"`).join(',')})
             VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})
             ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET
               on_hand = EXCLUDED.on_hand,
               committed = EXCLUDED.committed,
               packing = EXCLUDED.packing,
               unavailable = EXCLUDED.unavailable,
               incoming = EXCLUDED.incoming,
               updated_at = COALESCE(EXCLUDED.updated_at, NOW())
            `,
            cols.map((c) => row[c]),
          );
          n += r.rowCount || 0;
        }
        console.log(`OK  inventory_levels: upserted ~${n}`);
      } else console.log(`DRY inventory_levels: ${srcRows.length}`);
    }

    // suppliers
    {
      const srcRows = await fetchAll(src, 'suppliers');
      for (const row of srcRows) {
        const mapped = remapRow(row, maps);
        if (DRY) {
          maps.supplier.set(Number(row.id), Number(row.id));
          continue;
        }
        const cols = await commonCols(src, dst, 'suppliers');
        try {
          await dst.query(
            `INSERT INTO suppliers (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
            cols.map((c) => mapped[c]),
          );
          maps.supplier.set(Number(row.id), Number(row.id));
        } catch {
          const colsNoId = cols.filter((c) => c !== 'id');
          const r = await dst.query(
            `INSERT INTO suppliers (${colsNoId.map((c) => `"${c}"`).join(',')}) VALUES (${colsNoId.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
            colsNoId.map((c) => mapped[c]),
          );
          maps.supplier.set(Number(row.id), Number(r.rows[0].id));
        }
      }
      if (!DRY) await resetSeq(dst, 'suppliers');
      console.log(`MAP suppliers: ${maps.supplier.size}`);
    }

    // Helper for id-remap tables
    async function copyWithIdMap(table, mapKey, parentRemap = true) {
      const srcRows = await fetchAll(src, table);
      if (!srcRows.length) {
        console.log(`SKIP ${table} (empty)`);
        return;
      }
      if (DRY) {
        for (const r of srcRows) maps[mapKey].set(Number(r.id), Number(r.id));
        console.log(`DRY ${table}: ${srcRows.length}`);
        return;
      }
      const cols = await commonCols(src, dst, table);
      let n = 0;
      for (const row of srcRows) {
        const mapped = parentRemap ? remapRow(row, maps) : row;
        try {
          await dst.query(
            `INSERT INTO public."${table}" (${cols.map((c) => `"${c}"`).join(',')})
             VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
            cols.map((c) => mapped[c]),
          );
          maps[mapKey].set(Number(row.id), Number(row.id));
          n++;
        } catch (e) {
          const colsNoId = cols.filter((c) => c !== 'id');
          try {
            const r = await dst.query(
              `INSERT INTO public."${table}" (${colsNoId.map((c) => `"${c}"`).join(',')})
               VALUES (${colsNoId.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
              colsNoId.map((c) => mapped[c]),
            );
            maps[mapKey].set(Number(row.id), Number(r.rows[0].id));
            n++;
          } catch (e2) {
            console.error(`  ! ${table} id=${row.id}: ${e2.message}`);
          }
        }
      }
      await resetSeq(dst, table);
      console.log(`OK  ${table}: +${n}/${srcRows.length}`);
    }

    await copyWithIdMap('purchase_orders', 'po');
    await copySimple(src, dst, 'purchase_order_items', maps, { onConflictNothing: true, conflictCols: ['id'] });
    await copyWithIdMap('goods_receipts', 'gr');
    await copySimple(src, dst, 'goods_receipt_items', maps, { onConflictNothing: true, conflictCols: ['id'] });
    await copyWithIdMap('stock_transfers', 'stn');
    await copySimple(src, dst, 'stock_transfer_items', maps, { onConflictNothing: true, conflictCols: ['id'] });
    await copyWithIdMap('purchase_returns', 'pvn');
    await copySimple(src, dst, 'purchase_return_items', maps, { onConflictNothing: true, conflictCols: ['id'] });

    await copyWithIdMap('customers', 'customer');
    await copyWithIdMap('orders', 'order');
    await copySimple(src, dst, 'order_items', maps, { onConflictNothing: true, conflictCols: ['id'] });
    await copyWithIdMap('draft_orders', 'draft');
    await copySimple(src, dst, 'draft_order_items', maps, { onConflictNothing: true, conflictCols: ['id'] });
    await copyWithIdMap('order_returns', 'orderReturn');
    await copySimple(src, dst, 'order_return_items', maps, { onConflictNothing: true, conflictCols: ['id'] });
    await copySimple(src, dst, 'vouchers', maps, { onConflictNothing: true, conflictCols: ['id'] });
    await copySimple(src, dst, 'supplier_ledger_entries', maps, { onConflictNothing: true, conflictCols: ['id'] });
    await copySimple(src, dst, 'customer_ledger_entries', maps, { onConflictNothing: true, conflictCols: ['id'] });
    await copyWithIdMap('conversations', 'conv');
    await copySimple(src, dst, 'conversation_messages', maps, { onConflictNothing: true, conflictCols: ['id'] });
    await copySimple(src, dst, 'inventory_movements', maps, { onConflictNothing: true, conflictCols: ['id'] });
    await copySimple(src, dst, 'activity_logs', maps, { onConflictNothing: true, conflictCols: ['id'] });

    if (!DRY) {
      console.log('\n✅ DONE — Warehouse data merged into shared DB');
    } else {
      console.log('\nDRY RUN complete — no changes written');
    }
  } catch (e) {
    console.error('\n❌ FAILED:', e.message);
    if (e.detail) console.error(' detail:', e.detail);
    if (e.hint) console.error(' hint:', e.hint);
    if (e.code) console.error(' code:', e.code);
    process.exitCode = 1;
  } finally {
    await src.end();
    await dst.end();
  }
})();
