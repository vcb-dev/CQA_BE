import {
  isRedisQuotaError,
  isRedisCircuitOpen,
  tripRedisCircuit,
  onRedisQuotaTripped,
  resetRedisCircuitForTests,
} from './cskh-redis-circuit';

describe('cskh-redis-circuit', () => {
  beforeEach(() => {
    resetRedisCircuitForTests();
  });

  it('nhận diện lỗi Upstash quota', () => {
    expect(
      isRedisQuotaError(new Error('ERR max requests limit exceeded. Limit: 500000')),
    ).toBe(true);
    expect(isRedisQuotaError(new Error('connection refused'))).toBe(false);
  });

  it('mở circuit sau trip và đóng sau reset', () => {
    expect(isRedisCircuitOpen()).toBe(false);
    tripRedisCircuit(1000);
    expect(isRedisCircuitOpen()).toBe(true);
    resetRedisCircuitForTests();
    expect(isRedisCircuitOpen()).toBe(false);
  });

  it('onRedisQuotaTripped không spam log trong 60s', () => {
    const logs: string[] = [];
    const logger = { error: (msg: string) => logs.push(msg) };
    onRedisQuotaTripped(logger);
    onRedisQuotaTripped(logger);
    expect(logs.length).toBe(1);
    expect(isRedisCircuitOpen()).toBe(true);
  });
});
