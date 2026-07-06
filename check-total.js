const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const total = await p.cskhInboxMessage.count();
  const convs = await p.cskhInboxConversation.count();
  const pagesWithMsgs = await p.$queryRawUnsafe(
    `SELECT COUNT(DISTINCT c.page_id)::int n FROM cskh_inbox_messages m JOIN cskh_inbox_conversations c ON c.id=m.conversation_id`,
  );
  console.log(`Tổng tin: ${total} | hội thoại: ${convs} | số page CÓ tin: ${pagesWithMsgs[0].n}/87`);
  await p.$disconnect();
})();
