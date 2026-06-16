const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    const msgs = await prisma.cskhInboxMessage.findMany({
      orderBy: { sentAt: 'desc' },
      take: 5,
      include: {
        conversation: {
          select: {
            pageName: true,
            customerName: true,
            participantPsid: true,
          }
        }
      }
    });
    console.log('--- RECENT 5 MESSAGES ---');
    console.log(JSON.stringify(msgs.map(m => ({
      id: m.id,
      text: m.text,
      senderType: m.senderType,
      direction: m.direction,
      sentAt: m.sentAt,
      fbMessageId: m.fbMessageId,
      pageName: m.conversation?.pageName,
      customerName: m.conversation?.customerName,
      customerPsid: m.conversation?.participantPsid,
    })), null, 2));
  } catch (error) {
    console.error('Error fetching recent messages:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
