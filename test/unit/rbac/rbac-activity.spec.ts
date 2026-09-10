import { of } from 'rxjs';
import { RbacActivityService } from '../../../src/rbac/rbac-activity.service';
import { RbacActivityInterceptor } from '../../../src/rbac/rbac-activity.interceptor';

describe('RbacActivityService', () => {
  const makeSvc = () => {
    const svc = new RbacActivityService({ get: () => undefined } as never);
    const redis = { status: 'ready', set: jest.fn().mockResolvedValue('OK'), mget: jest.fn() };
    (svc as unknown as { redis: unknown }).redis = redis;
    return { svc, redis };
  };

  /** Redis chưa sẵn sàng (chưa connect được / mất kết nối) — status khác 'ready'. */
  const makeSvcRedisDown = () => {
    const svc = new RbacActivityService({ get: () => undefined } as never);
    const redis = { status: 'end', set: jest.fn(), mget: jest.fn() };
    (svc as unknown as { redis: unknown }).redis = redis;
    return { svc, redis };
  };

  it('markActive: chỉ ghi Redis 1 lần trong cửa sổ throttle', async () => {
    const { svc, redis } = makeSvc();
    await svc.markActive(1);
    await svc.markActive(1);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set.mock.calls[0][0]).toBe('rbac:last_active:1');
  });

  it('markActive: user khác nhau ghi riêng', async () => {
    const { svc, redis } = makeSvc();
    await svc.markActive(1);
    await svc.markActive(2);
    expect(redis.set).toHaveBeenCalledTimes(2);
  });

  it('getActiveMap: gộp kết quả mget theo String(id)', async () => {
    const { svc, redis } = makeSvc();
    redis.mget.mockResolvedValue(['2026-09-10T03:00:00.000Z', null]);
    const map = await svc.getActiveMap([1, 2]);
    expect(map.get('1')).toBe('2026-09-10T03:00:00.000Z');
    expect(map.has('2')).toBe(false);
  });

  it('getActiveMap: list rỗng → Map rỗng, không gọi Redis', async () => {
    const { svc, redis } = makeSvc();
    const map = await svc.getActiveMap([]);
    expect(map.size).toBe(0);
    expect(redis.mget).not.toHaveBeenCalled();
  });

  it('markActive: Redis chưa sẵn sàng → không gọi set, không ném lỗi', async () => {
    const { svc, redis } = makeSvcRedisDown();
    await expect(svc.markActive(1)).resolves.toBeUndefined();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('getActiveMap: Redis chưa sẵn sàng → Map rỗng, không gọi mget', async () => {
    const { svc, redis } = makeSvcRedisDown();
    const map = await svc.getActiveMap([1, 2]);
    expect(map.size).toBe(0);
    expect(redis.mget).not.toHaveBeenCalled();
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
