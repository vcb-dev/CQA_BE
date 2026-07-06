const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const totalPages = (await p.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM facebook_cskh_configs`))[0].n;
  const noToken = (await p.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM facebook_cskh_configs WHERE page_access_token IS NULL OR page_access_token = ''`))[0].n;
  const totalMsgs = (await p.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM cskh_inbox_messages`))[0].n;
  const totalConvs = (await p.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM cskh_inbox_conversations`))[0].n;

  const rows = await p.$queryRawUnsafe(`
    SELECT cfg.page_id AS "pageId",
           cfg.page_name AS "pageName",
           (cfg.page_access_token IS NOT NULL AND cfg.page_access_token <> '') AS "hasToken",
           cfg.enabled AS "enabled",
           COALESCE(conv.cnt, 0)::int AS "convCount",
           COALESCE(msg.cnt, 0)::int AS "msgCount"
    FROM facebook_cskh_configs cfg
    LEFT JOIN (
      SELECT page_id, COUNT(*) cnt FROM cskh_inbox_conversations GROUP BY page_id
    ) conv ON conv.page_id = cfg.page_id
    LEFT JOIN (
      SELECT c.page_id, COUNT(*) cnt
      FROM cskh_inbox_messages m
      JOIN cskh_inbox_conversations c ON c.id = m.conversation_id
      GROUP BY c.page_id
    ) msg ON msg.page_id = cfg.page_id
    ORDER BY "msgCount" ASC
  `);

  const emptyMsg = rows.filter((r) => r.msgCount === 0);
  const emptyButHasToken = emptyMsg.filter((r) => r.hasToken);

  console.log(`=== TỔNG QUAN ===`);
  console.log(`Tổng page cấu hình : ${totalPages}`);
  console.log(`Page KHÔNG có token: ${noToken}`);
  console.log(`Tổng hội thoại     : ${totalConvs}`);
  console.log(`Tổng tin nhắn      : ${totalMsgs}`);
  console.log(`Page có tin nhắn   : ${rows.length - emptyMsg.length}/${totalPages}`);
  console.log(`Page RỖNG (0 tin)  : ${emptyMsg.length}`);
  console.log(`  → trong đó CÓ token (đáng lẽ quét được): ${emptyButHasToken.length}`);
  console.log('');
  console.log(`=== 25 PAGE RỖNG ĐẦU (CÓ token) ===`);
  emptyButHasToken.slice(0, 25).forEach((r) => {
    console.log(`  [${r.enabled ? 'ON ' : 'off'}] ${r.pageName || r.pageId} (conv=${r.convCount})`);
  });
  console.log('');
  console.log(`=== 10 PAGE NHIỀU TIN NHẤT ===`);
  rows.slice().sort((a, b) => b.msgCount - a.msgCount).slice(0, 10).forEach((r) => {
    console.log(`  ${r.msgCount} tin | ${r.pageName || r.pageId}`);
  });

  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
