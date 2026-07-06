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

    const convs = await prisma.cskhInboxConversation.findMany({
      orderBy: { lastMessageAt: 'desc' },
      take: 10,
    });
    console.log('--- RECENT 10 CONVERSATIONS WITH UNREAD COUNT ---');
    console.log(JSON.stringify(convs.map(c => ({
      id: c.id,
      customerName: c.customerName,
      pageName: c.pageName,
      unreadCount: c.unreadCount,
      lastMessage: c.lastMessage,
      lastMessageAt: c.lastMessageAt,
    })), null, 2));

  } catch (error) {
    console.error('Error fetching recent messages:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
