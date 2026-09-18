import { of } from 'rxjs';
import { RbacActivityService } from '../../../src/rbac/activity/rbac-activity.service';
import { RbacActivityInterceptor } from '../../../src/rbac/activity/rbac-activity.interceptor';

describe('RbacActivityService', () => {
  const makePrisma = () => {
    const state: { existing: bigint[] } = { existing: [] };
    return {
      state,
      user: {
        findMany: jest.fn(({ where }: { where: { id: { in: bigint[] } } }) =>
          Promise.resolve(
            where.id.in
              .filter((id) => state.existing.includes(id))
              .map((id) => ({ id })),
          ),
        ),
        update: jest.fn((args: { where: { id: bigint } }) =>
          Promise.resolve({ id: args.where.id }),
        ),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
  };

  it('markActive: chỉ ghi vào bộ nhớ, không đụng DB', () => {
    const prisma = makePrisma();
    const svc = new RbacActivityService(prisma as never);
    svc.markActive(1);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('flush: pending rỗng → không gọi DB', async () => {
    const prisma = makePrisma();
    const svc = new RbacActivityService(prisma as never);
    await svc.flush();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('flush: gom nhiều user đang chờ, ghi cả lô trong 1 transaction', async () => {
    const prisma = makePrisma();
    prisma.state.existing = [1n, 2n];
    const svc = new RbacActivityService(prisma as never);
    svc.markActive(1);
    svc.markActive(2);
    await svc.flush();

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledTimes(2);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1n } }),
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 2n } }),
    );
  });

  it('flush: lọc bỏ user không còn tồn tại, không kéo cả lô rollback', async () => {
    const prisma = makePrisma();
    prisma.state.existing = [1n]; // user 2 coi như đã bị xóa
    const svc = new RbacActivityService(prisma as never);
    svc.markActive(1);
    svc.markActive(2);
    await svc.flush();

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1n } }),
    );
  });

  it('flush: tất cả user trong lô đều không còn tồn tại → không gọi transaction', async () => {
    const prisma = makePrisma();
    prisma.state.existing = [];
    const svc = new RbacActivityService(prisma as never);
    svc.markActive(1);
    await svc.flush();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('flush: xóa pending sau khi flush — gọi flush lần nữa không ghi lại', async () => {
    const prisma = makePrisma();
    prisma.state.existing = [1n];
    const svc = new RbacActivityService(prisma as never);
    svc.markActive(1);
    await svc.flush();
    await svc.flush();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('flush: DB lỗi → không ném lỗi ra ngoài', async () => {
    const prisma = makePrisma();
    prisma.user.findMany.mockRejectedValue(new Error('DB busy'));
    const svc = new RbacActivityService(prisma as never);
    svc.markActive(1);
    await expect(svc.flush()).resolves.toBeUndefined();
  });

  it('onModuleDestroy: flush nốt phần đang chờ trước khi server tắt', async () => {
    const prisma = makePrisma();
    prisma.state.existing = [1n];
    const svc = new RbacActivityService(prisma as never);
    svc.markActive(1);
    await svc.onModuleDestroy();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('RbacActivityInterceptor', () => {
  const ctx = (user: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as never;
  const next = { handle: () => of('ok') };

  it('có req.user.id → gọi markActive', () => {
    const activity = { markActive: jest.fn() };
    const interceptor = new RbacActivityInterceptor(activity as never);
    interceptor.intercept(ctx({ id: 9n }), next as never);
    expect(activity.markActive).toHaveBeenCalledWith(9n);
  });

  it('không có user → không gọi, vẫn trả handle()', (done) => {
    const activity = { markActive: jest.fn() };
    const interceptor = new RbacActivityInterceptor(activity as never);
    interceptor.intercept(ctx(undefined), next as never).subscribe((v) => {
      expect(v).toBe('ok');
      expect(activity.markActive).not.toHaveBeenCalled();
      done();
    });
  });
});
