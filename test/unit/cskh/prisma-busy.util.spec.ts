import { isPrismaBusyError, isPrismaClientFailure } from '../../../src/common/prisma-busy.util';

describe('prisma-busy', () => {
  it('nhận pool timeout — không để thành lỗi lạ', () => {
    expect(
      isPrismaBusyError(
        new Error(
          'Timed out fetching a new connection from the connection pool. (Current connection pool timeout: 20, connection limit: 2)',
        ),
      ),
    ).toBe(true);
    expect(isPrismaBusyError({ code: 'P2024', message: 'pool' })).toBe(true);
    expect(isPrismaBusyError(new Error('unique constraint failed'))).toBe(false);
  });

  it('nhận Prisma invocation như client failure', () => {
    expect(
      isPrismaClientFailure(
        new Error("Invalid `prisma.cskhInboxConversation.groupBy()` invocation:"),
      ),
    ).toBe(true);
  });
});
