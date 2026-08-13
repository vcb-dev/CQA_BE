const { PrismaClient } = require('@prisma/client');

const p = new PrismaClient();

async function main() {
  await p.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS pancake_oauth_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pancake_user_id TEXT NOT NULL UNIQUE,
      user_name VARCHAR,
      user_access_token TEXT NOT NULL,
      token_expires_at TIMESTAMPTZ,
      metadata JSONB,
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await p.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS pancake_page_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      page_id TEXT NOT NULL UNIQUE,
      page_name VARCHAR,
      platform VARCHAR,
      page_access_token TEXT NOT NULL,
      metadata JSONB,
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await p.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS pancake_page_configs_tenant_id_idx
    ON pancake_page_configs(tenant_id);
  `);

  await p.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS pancake_leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      page_id TEXT NOT NULL,
      page_name VARCHAR,
      platform VARCHAR,
      pancake_customer_id TEXT NOT NULL,
      customer_id TEXT,
      psid TEXT,
      full_name VARCHAR,
      phones TEXT[] NOT NULL DEFAULT '{}',
      emails TEXT[] NOT NULL DEFAULT '{}',
      address TEXT,
      notes TEXT,
      gender VARCHAR,
      conversation_id TEXT,
      last_message TEXT,
      conversation_type VARCHAR,
      data_at TIMESTAMPTZ,
      source VARCHAR NOT NULL DEFAULT 'sync',
      raw JSONB,
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (page_id, pancake_customer_id)
    );
  `);
  await p.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS pancake_leads_page_id_idx ON pancake_leads(page_id);
  `);
  await p.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS pancake_leads_tenant_id_idx ON pancake_leads(tenant_id);
  `);
  await p.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS pancake_leads_updated_at_idx ON pancake_leads(updated_at);
  `);

  // Pipeline CRM: hội thoại → khách khi có đơn
  await p.$executeRawUnsafe(`
    ALTER TABLE pancake_leads
      ADD COLUMN IF NOT EXISTS stage VARCHAR(32) NOT NULL DEFAULT 'conversation',
      ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS follow_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS ordered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS order_ref VARCHAR(64);
  `);
  await p.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS pancake_leads_stage_idx ON pancake_leads(stage);
  `);

  console.log('ok: pancake tables ready (sessions, page_configs, leads + stage)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await p.$disconnect();
  });
