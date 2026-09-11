import { of } from 'rxjs';
import { RbacActivityService } from '../../../src/rbac/rbac-activity.service';
import { RbacActivityInterceptor } from '../../../src/rbac/rbac-activity.interceptor';

describe('RbacActivityService', () => {
  const makeSvc = () => {
    const svc = new RbacActivityService({ get: () => undefined } as never);
    const redis = {
      status: 'ready',
      set: jest.fn().mockResolvedValue('OK'),
      mget: jest.fn(),
    };
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

  it('markActive: bộ nhớ ghi mọi lần, kể cả khi Redis bị throttle', async () => {
    const { svc, redis } = makeSvc();
    await svc.markActive(1);
    await svc.markActive(1);
    // Redis chỉ 1 lần...
    expect(redis.set).toHaveBeenCalledTimes(1);
    // ...nhưng mốc trong bộ nhớ vẫn đọc ra được.
    redis.mget.mockResolvedValue([null]);
    const map = await svc.getActiveMap([1]);
    expect(map.get('1')).toBeDefined();
  });

  it('getActiveMap: gộp kết quả mget theo String(id)', async () => {
    const { svc, redis } = makeSvc();
    redis.mget.mockResolvedValue(['2026-09-10T03:00:00.000Z', null]);
    const map = await svc.getActiveMap([1, 2]);
    expect(map.get('1')).toBe('2026-09-10T03:00:00.000Z');
    // Chưa markActive nên không có mốc nào cho user 2.
    expect(map.has('2')).toBe(false);
  });

  it('getActiveMap: bộ nhớ mới hơn Redis thì lấy bộ nhớ', async () => {
    const { svc, redis } = makeSvc();
    await svc.markActive(1);
    // Redis giữ mốc cũ vì chỉ đồng bộ 5 phút/lần.
    redis.mget.mockResolvedValue(['2020-01-01T00:00:00.000Z']);
    const map = await svc.getActiveMap([1]);
    expect(new Date(map.get('1')!).getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00.000Z').getTime(),
    );
  });

  it('getActiveMap: Redis mới hơn bộ nhớ thì lấy Redis', async () => {
    const { svc, redis } = makeSvc();
    await svc.markActive(1);
    const future = new Date(Date.now() + 60_000).toISOString();
    redis.mget.mockResolvedValue([future]);
    const map = await svc.getActiveMap([1]);
    expect(map.get('1')).toBe(future);
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

  it('getActiveMap: Redis chưa sẵn sàng vẫn trả mốc từ bộ nhớ', async () => {
    const { svc, redis } = makeSvcRedisDown();
    await svc.markActive(1);
    const map = await svc.getActiveMap([1, 2]);
    expect(map.get('1')).toBeDefined();
    expect(map.has('2')).toBe(false);
    expect(redis.mget).not.toHaveBeenCalled();
  });

  it('getActiveMap: chưa ai hoạt động + Redis chết → Map rỗng', async () => {
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
