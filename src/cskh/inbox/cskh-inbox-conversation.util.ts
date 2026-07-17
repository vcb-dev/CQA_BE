import type { CskhInboxConversation, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export function isInboxSchemaMigrationError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e ?? '');
  return (
    msg.includes('awaiting_label') ||
    msg.includes('cskh_inbox_labels') ||
    msg.includes('cskh_inbox_conversation_labels') ||
    msg.includes('cskh_inbox_conversation_views') ||
    /does not exist/i.test(msg)
  );
}

export function isPrismaPoolTimeout(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e ?? '');
  return /connection pool/i.test(msg) || /Timed out fetching a new connection/i.test(msg);
}

export function isPrismaStatementTimeout(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e ?? '');
  return /statement timeout/i.test(msg) || /\b57014\b/.test(msg);
}

/** Pool đầy hoặc query vượt statement_timeout — nên retry / trả 503. */
export function isPrismaRetryableDbError(e: unknown): boolean {
  return isPrismaPoolTimeout(e) || isPrismaStatementTimeout(e);
}

export const CONVERSATION_ACCESS_SELECT_LEGACY = {
  id: true,
  pageId: true,
  pageName: true,
  fbConversationId: true,
  participantPsid: true,
  customerName: true,
  customerPictureUrl: true,
  fromAd: true,
  adId: true,
  adTitle: true,
  referralSource: true,
  referralAt: true,
  lastMessage: true,
  lastMessageAt: true,
  unreadCount: true,
  tenantId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const CONVERSATION_ACCESS_SELECT = {
  ...CONVERSATION_ACCESS_SELECT_LEGACY,
  awaitingLabel: true,
} as const;

export type InboxConversationAccess = Pick<
  CskhInboxConversation,
  keyof typeof CONVERSATION_ACCESS_SELECT_LEGACY | 'awaitingLabel'
>;

async function findWithMigrationFallback(
  prisma: PrismaService,
  where: Prisma.CskhInboxConversationWhereInput,
): Promise<InboxConversationAccess | null> {
  try {
    return await prisma.cskhInboxConversation.findFirst({
      where,
      select: CONVERSATION_ACCESS_SELECT,
    });
  } catch (e) {
    if (!isInboxSchemaMigrationError(e)) throw e;
    const row = await prisma.cskhInboxConversation.findFirst({
      where,
      select: CONVERSATION_ACCESS_SELECT_LEGACY,
    });
    return row ? { ...row, awaitingLabel: false } : null;
  }
}

export async function findInboxConversationById(
  prisma: PrismaService,
  conversationId: string,
  tenantId?: string,
): Promise<InboxConversationAccess | null> {
  const where = tenantId ? { id: conversationId, tenantId } : { id: conversationId };
  return findWithMigrationFallback(prisma, where);
}

export async function findInboxConversationByPageParticipant(
  prisma: PrismaService,
  pageId: string,
  participantPsid: string,
  tenantId?: string,
): Promise<InboxConversationAccess | null> {
  const where = tenantId
    ? { pageId, participantPsid, tenantId }
    : { pageId, participantPsid };
  return findWithMigrationFallback(prisma, where);
}
