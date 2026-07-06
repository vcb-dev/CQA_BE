const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log('--- USERS & TENANTS ---');
    const users = await prisma.user.findMany({
      select: { id: true, email: true, tenantId: true }
    });
    users.forEach(u => {
      console.log(`User: ${u.email} | TenantId: ${u.tenantId}`);
    });

    console.log('--- RECENT 50 JOB RUNS ---');
    const jobs = await prisma.cskhJobRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 50
    });

    jobs.forEach(j => {
      const summary = j.summary || {};
      console.log(`- Job ID: ${j.id.slice(0,8)} | Type: ${j.type} | Status: ${j.status} | TenantId: ${j.tenantId} | PageId: ${summary.pageId || 'all'} | PageName: ${summary.currentPage || 'all'} | DateRange: ${summary.auditDateFrom} -> ${summary.auditDateTo} | Started: ${j.startedAt.toISOString()}`);
      if (j.error) console.log(`  Error: ${j.error}`);
    });
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
