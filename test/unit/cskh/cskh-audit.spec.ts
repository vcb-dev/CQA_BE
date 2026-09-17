import { AiService } from '../../../src/ai/ai.service';
import type { PrismaService } from '../../../src/prisma/prisma.service';
import { CskhCronService } from '../../../src/cskh/cskh-cron.service';
import { CskhService } from '../../../src/cskh/cskh.service';
import { CskhController } from '../../../src/cskh/cskh.controller';
import type { CskhInboxService } from '../../../src/cskh/inbox/cskh-inbox.service';
import type { RedisQueueService } from '../../../src/cskh/redis/redis-queue.service';
import { FacebookGraphService, type FbConversation } from '../../../src/cskh/facebook/facebook-graph.service';
import { trimTranscriptForAi } from '../../../src/cskh/audit/audit-analytics.util';

type AuditRow = {
  pageId: string | null;
  conversationId: string | null;
  participantPsid: string | null;
};

const auditRow = (
  conversationId: string | null,
  participantPsid: string | null,
  pageId = 'p1',
): AuditRow => ({ pageId, conversationId, participantPsid });

const graph = new FacebookGraphService(null as any, null as any);

function conversation(
  pageId: string,
  id: string,
  psid: string,
): FbConversation {
  return {
    id,
    participants: { data: [{ id: pageId }, { id: psid }] },
    messages: {
      data: [
        {
          id: `${id}-staff`,
          from: { id: pageId },
          message: 'Dạ mẫu này giá 100k ạ',
          created_time: '2026-09-13T08:01:00+07:00',
        },
        {
          id: `${id}-customer`,
          from: { id: psid },
          message: 'Cho mình hỏi giá',
          created_time: '2026-09-13T08:00:00+07:00',
        },
      ],
    },
  };
}

describe('CskhCronService.scheduledAudit — xếp hàng audit đêm', () => {
  const pages = [
    { pageId: 'p1', pageName: 'Kênh 1', tenantId: 't1' },
    { pageId: 'p2', pageName: 'Kênh 2', tenantId: 't1' },
    { pageId: 'p3', pageName: 'Kênh 3', tenantId: 't2' },
  ];

  let createdJobs: Array<{ type: string; tenantId?: string; status?: string }>;
  let enqueued: Array<{ jobId: string; options: Record<string, unknown> }>;
  let finished: Array<{ jobId: string; status: string }>;
  let cskh: jest.Mocked<Pick<CskhService, 'getAuditCronDefaults' | 'buildAuditDateRange' |
    'listConnectedPages' | 'releaseStaleJobs' | 'findActiveJob' | 'findRunningJob' |
    'createJob' | 'finishJob'>>;
  let redisQueue: { enqueueAuditJob: jest.Mock };
  let service: CskhCronService;
  let prevRunMode: string | undefined;
  let prevCronEnabled: string | undefined;

  const build = () =>
    new CskhCronService(
      cskh as unknown as CskhService,
      {} as CskhInboxService,
      redisQueue as unknown as RedisQueueService,
    );

  beforeEach(() => {
    prevRunMode = process.env.CSKH_RUN_MODE;
    prevCronEnabled = process.env.CSKH_CRON_ENABLED;
    process.env.CSKH_RUN_MODE = 'api';
    process.env.CSKH_CRON_ENABLED = 'true';

    createdJobs = [];
    enqueued = [];
    finished = [];

    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout);

    cskh = {
      getAuditCronDefaults: jest.fn().mockReturnValue({ maxConversations: 50, lookbackDays: 1 }),
      buildAuditDateRange: jest
        .fn()
        .mockReturnValue({ auditDateFrom: '2026-09-13', auditDateTo: '2026-09-14' }),
      listConnectedPages: jest.fn().mockResolvedValue(pages),
      releaseStaleJobs: jest.fn().mockResolvedValue({ running: 0, queued: 0 }),
      findActiveJob: jest.fn().mockResolvedValue(null),
      findRunningJob: jest.fn().mockResolvedValue(null),
      createJob: jest.fn().mockImplementation(async (type: string, tenantId?: string, status?: string) => {
        const job = { id: `job-${createdJobs.length + 1}`, type, tenantId, status };
        createdJobs.push({ type, tenantId, status });
        return job;
      }),
      finishJob: jest.fn().mockImplementation(async (jobId: string, status: string) => {
        finished.push({ jobId, status });
        return null;
      }),
    } as never;

    redisQueue = {
      enqueueAuditJob: jest.fn().mockImplementation(async (payload) => {
        enqueued.push(payload);
        return true;
      }),
    };

    service = build();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.CSKH_RUN_MODE = prevRunMode;
    process.env.CSKH_CRON_ENABLED = prevCronEnabled;
  });

  it('xếp hàng đủ MỘT job cho mỗi kênh, không dừng sớm ở kênh thứ 2', async () => {
    await service.scheduledAudit();

    expect(enqueued).toHaveLength(pages.length);
    expect(enqueued.map((e) => (e.options as { pageId: string }).pageId)).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
  });

  it('tạo job ở trạng thái "queued" để hàng đợi không bị hiểu nhầm là đang chạy', async () => {
    await service.scheduledAudit();

    expect(createdJobs).toHaveLength(pages.length);
    expect(createdJobs.every((j) => j.status === 'queued')).toBe(true);
    expect(createdJobs.map((j) => j.tenantId)).toEqual(['t1', 't1', 't2']);
  });

  it('không gọi findRunningJob bên trong vòng lặp (nguồn gốc bug tự chặn chính mình)', async () => {
    await service.scheduledAudit();

    expect(cskh.findRunningJob).not.toHaveBeenCalled();
    expect(cskh.findActiveJob).toHaveBeenCalledTimes(1);
  });

  it('dọn job mồ côi TRƯỚC khi kiểm tra guard, nếu không job queued kẹt sẽ chặn vĩnh viễn', async () => {
    const order: string[] = [];
    cskh.releaseStaleJobs.mockImplementation(async () => {
      order.push('release');
      return { running: 0, queued: 1 };
    });
    cskh.findActiveJob.mockImplementation(async () => {
      order.push('guard');
      return null;
    });

    await service.scheduledAudit();

    expect(order).toEqual(['release', 'guard']);
    const [, runningMaxAge, , queuedMaxAge] = cskh.releaseStaleJobs.mock.calls[0];
    expect(queuedMaxAge).toBeLessThan(runningMaxAge as number);
  });

  it('bỏ qua cả đêm khi đã có job audit đang chạy hoặc còn nằm hàng đợi', async () => {
    cskh.findActiveJob.mockResolvedValue({ id: 'job-cu', status: 'queued' } as never);

    await service.scheduledAudit();

    expect(createdJobs).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it('đóng job lại khi Redis queue tắt, không bỏ lại row "queued" mồ côi', async () => {
    redisQueue.enqueueAuditJob.mockResolvedValue(false);

    await service.scheduledAudit();

    expect(createdJobs).toHaveLength(pages.length);
    expect(finished).toHaveLength(pages.length);
    expect(finished.every((f) => f.status === 'failed')).toBe(true);
  });

  it('không chạy khi process không phải API hoặc cron bị tắt', async () => {
    process.env.CSKH_RUN_MODE = 'worker';
    await build().scheduledAudit();
    expect(cskh.listConnectedPages).not.toHaveBeenCalled();

    process.env.CSKH_RUN_MODE = 'api';
    process.env.CSKH_CRON_ENABLED = 'false';
    await build().scheduledAudit();
    expect(cskh.listConnectedPages).not.toHaveBeenCalled();
  });
});

describe('audit message scope', () => {
  const graph = new FacebookGraphService(null as any, null as any);
  const PAGE_ID = 'page-1';

  const staffMsg = (iso: string) => ({
    id: `s-${iso}`,
    message: 'Dạ bên em tư vấn size như sau ạ',
    created_time: iso,
    from: { id: PAGE_ID, name: 'Staff' },
  });
  const customerMsg = (iso: string, text = 'ok em suy nghĩ thêm') => ({
    id: `c-${iso}`,
    message: text,
    created_time: iso,
    from: { id: 'psid-9', name: 'Customer' },
  });

  const messages = [
    customerMsg('2026-01-11T09:00:00+07:00'),
    staffMsg('2026-01-10T15:30:00+07:00'),
    customerMsg('2026-01-10T15:00:00+07:00', 'shop ơi cho em hỏi giá'),
  ];

  it('tách được tin trong ngày chấm và toàn bộ lịch sử đến hết ngày đó', () => {
    const range = graph.filterMessagesByDateRange(messages, '2026-01-11', '2026-01-11');
    const history = graph.filterMessagesUpToRangeEnd(messages, '2026-01-11');

    expect(range).toHaveLength(1);
    expect(history).toHaveLength(3);
  });

  it('KHÔNG coi là "NV chưa rep" khi lịch sử trước đó đã có tin Staff', () => {
    const range = graph.filterMessagesByDateRange(messages, '2026-01-11', '2026-01-11');
    const history = graph.filterMessagesUpToRangeEnd(messages, '2026-01-11');

    expect(graph.hasStaffMessage(range, PAGE_ID)).toBe(false);
    expect(graph.hasStaffMessage(history, PAGE_ID)).toBe(true);
  });

  it('vẫn ép 0 điểm khi hội thoại chưa từng có tin Staff', () => {
    const neverReplied = [customerMsg('2026-01-11T09:00:00+07:00', 'shop còn hàng không ạ')];
    const history = graph.filterMessagesUpToRangeEnd(neverReplied, '2026-01-11');

    expect(graph.hasStaffMessage(history, PAGE_ID)).toBe(false);
  });

  it('không kéo tin của ngày sau vào transcript', () => {
    const withNextDay = [staffMsg('2026-01-12T08:00:00+07:00'), ...messages];
    const history = graph.filterMessagesUpToRangeEnd(withNextDay, '2026-01-11');

    expect(history).toHaveLength(3);
    expect(history.some((m) => m.created_time?.startsWith('2026-01-12'))).toBe(false);
  });
});

describe('trimTranscriptForAi', () => {
  const line = (i: number) => ({ sender: i === 0 ? 'Staff' : 'Customer', text: `tin ${i}` });

  it('giữ 8 dòng đầu (lời chào) khi phải cắt bớt', () => {
    const full = Array.from({ length: 300 }, (_, i) => line(i));
    const trimmed = trimTranscriptForAi(full, 120);

    expect(trimmed.length).toBeLessThan(full.length);
    expect(trimmed.slice(0, 8)).toEqual(full.slice(0, 8));
    expect(trimmed[8]?.text).toContain('tin nhắn');
    expect(trimmed[trimmed.length - 1]).toEqual(full[full.length - 1]);
  });

  it('không cắt gì khi transcript ngắn hơn trần', () => {
    const full = Array.from({ length: 50 }, (_, i) => line(i));
    expect(trimTranscriptForAi(full, 120)).toEqual(full);
  });

  it('trần gửi AI mặc định phải NHỎ HƠN trần nạp tin, nếu không head+tail không bao giờ chạy', () => {
    const msgLimit = Number(process.env.CSKH_AUDIT_MSG_LIMIT || 300);
    const aiMax = Number(process.env.CSKH_AUDIT_AI_TRANSCRIPT_MAX || 120);
    expect(aiMax).toBeLessThan(msgLimit);
  });
});

describe('AiService.auditChat — AI báo lỗi thì không được ghi chat_audits', () => {
  let create: jest.Mock;
  let post: jest.Mock;
  let service: AiService;

  const validTranscript = [
    { sender: 'Customer', content: 'giá bao nhiêu ạ' },
    { sender: 'Staff', content: 'dạ mẫu này 500k ạ' },
  ];

  beforeEach(() => {
    create = jest.fn().mockResolvedValue({ id: 'audit-1', score: 80 });
    post = jest.fn();
    const prisma = {
      chatAudit: { create },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    service = new AiService(prisma);
    (service as unknown as { aiHttp: { post: jest.Mock } }).aiHttp = { post };
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parse_failed: không create, trả error kèm reason', async () => {
    post.mockResolvedValue({
      data: {
        error: true,
        reason: 'parse_failed',
        message: 'Lỗi phân tích kết quả từ AI: Got invalid JSON object',
        raw_preview: '{"score": 8',
      },
    });

    const result = await service.auditChat({
      transcript: validTranscript,
      metadata: { conversationId: 'c1' },
    });

    expect(create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: true, reason: 'parse_failed' });
    expect(result).not.toHaveProperty('id');
  });

  it('audit_failed (timeout/rate limit): không create, không lưu 0 điểm oan', async () => {
    post.mockResolvedValue({
      data: {
        error: true,
        reason: 'audit_failed',
        message: 'Không thể phân tích hội thoại: request timed out',
      },
    });

    const result = await service.auditChat({ transcript: validTranscript });

    expect(create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: true, reason: 'audit_failed' });
  });

  it('response rỗng / không phải object: coi là lỗi, không create', async () => {
    post.mockResolvedValue({ data: null });

    const result = await service.auditChat({ transcript: validTranscript });

    expect(create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: true, reason: 'invalid_ai_response' });
  });

  it('kết quả hợp lệ vẫn được lưu bình thường', async () => {
    post.mockResolvedValue({
      data: {
        score: 82,
        feedback: '+ Thái độ tốt',
        action_items: '',
        violations: [],
        customer_name: 'Anh Nam',
        agent_name: 'Mai',
      },
    });

    const result = await service.auditChat({ transcript: validTranscript });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.score).toBe(82);
    expect(result).toMatchObject({ id: 'audit-1' });
  });

  it('gửi transcript_trimmed khi bản rút gọn bị cắt đoạn giữa', async () => {
    post.mockResolvedValue({ data: { score: 75, feedback: '+ ok', violations: [] } });

    await service.auditChat({
      transcript: validTranscript,
      aiTranscript: [{ sender: 'Customer', text: 'giá bao nhiêu ạ' }],
      transcriptTrimmed: true,
      truncated: false,
    });

    expect(post.mock.calls[0][1]).toMatchObject({
      transcript_trimmed: true,
      truncated: false,
      no_reply: false,
    });
  });

  it('mặc định hai cờ cắt transcript đều false', async () => {
    post.mockResolvedValue({ data: { score: 75, feedback: '+ ok', violations: [] } });

    await service.auditChat({ transcript: validTranscript });

    expect(post.mock.calls[0][1]).toMatchObject({ transcript_trimmed: false, truncated: false });
  });
});


describe('CskhService.releaseStaleJobs — dọn cả job kẹt hàng đợi', () => {
  let findMany: jest.Mock;
  let updateMany: jest.Mock;
  let clearPause: jest.Mock;
  let activeJobs: Map<string, unknown>;
  let service: CskhService;

  const whereOf = (call: unknown[]) =>
    (call[0] as { where: { status: string; startedAt: { lt: Date } } }).where;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([{ id: 'job-kẹt' }]);
    updateMany = jest.fn().mockResolvedValue({ count: 1 });
    clearPause = jest.fn().mockResolvedValue(undefined);
    activeJobs = new Map([['job-kẹt', { pauseRequested: false }]]);

    service = Object.create(CskhService.prototype) as CskhService;
    Object.assign(service, {
      prisma: { cskhJobRun: { findMany, updateMany } },
      redisQueue: { clearAuditPauseRequested: clearPause },
      activeJobs,
      logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    });
  });

  it('quét CẢ running lẫn queued, mỗi loại một ngưỡng tuổi riêng', async () => {
    const result = await service.releaseStaleJobs('audit', 5 * 60 * 1000);

    expect(result).toEqual({ running: 1, queued: 1 });
    const statuses = updateMany.mock.calls.map((c) => whereOf(c).status);
    expect(statuses).toEqual(['running', 'queued']);

    const runningCutoff = whereOf(updateMany.mock.calls[0]).startedAt.lt.getTime();
    const queuedCutoff = whereOf(updateMany.mock.calls[1]).startedAt.lt.getTime();
    expect(queuedCutoff).toBeLessThan(runningCutoff);
  });

  it('giữ nguyên job còn mới — không có gì để dọn thì không UPDATE', async () => {
    findMany.mockResolvedValue([]);

    const result = await service.releaseStaleJobs('audit', 5 * 60 * 1000);

    expect(result).toEqual({ running: 0, queued: 0 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('dọn luôn state trong RAM và cờ pause của job bị hủy', async () => {
    await service.releaseStaleJobs('audit', 5 * 60 * 1000);

    expect(activeJobs.has('job-kẹt')).toBe(false);
    expect(clearPause).toHaveBeenCalledWith('job-kẹt');
  });

  it('lọc theo tenant khi được chỉ định', async () => {
    await service.releaseStaleJobs('audit', 5 * 60 * 1000, 'tenant-1');

    for (const call of findMany.mock.calls) {
      expect((call[0] as { where: { tenantId?: string } }).where.tenantId).toBe('tenant-1');
    }
  });
});

describe('CskhController.runAudit — chấm điểm thủ công', () => {
  const user = { tenantId: 't1' } as never;
  const body = { auditDateFrom: '2026-09-13', auditDateTo: '2026-09-13', pageId: 'p1' };

  let cskh: Record<string, jest.Mock>;
  let redisQueue: Record<string, jest.Mock>;
  let controller: CskhController;

  beforeEach(() => {
    cskh = {
      cancelRunningJobs: jest.fn().mockResolvedValue(0),
      releaseStaleJobs: jest.fn().mockResolvedValue({ running: 0, queued: 0 }),
      findActiveJob: jest.fn().mockResolvedValue(null),
      findRunningJob: jest.fn().mockResolvedValue(null),
      createJob: jest.fn().mockResolvedValue({ id: 'job-1', status: 'queued' }),
      runAuditJob: jest.fn().mockResolvedValue(undefined),
    };
    redisQueue = {
      enqueueAuditJob: jest.fn().mockResolvedValue(true),
      isAuditWorkerAlive: jest.fn().mockResolvedValue(true),
    };

    controller = Object.create(CskhController.prototype) as CskhController;
    Object.assign(controller, {
      cskh,
      redisQueue,
      logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    });
  });

  it('tạo job ở trạng thái "queued" rồi mới xếp hàng', async () => {
    const res = await controller.runAudit(user, body);

    expect(cskh.createJob).toHaveBeenCalledWith('audit', 't1', 'queued');
    expect(redisQueue.enqueueAuditJob).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ jobId: 'job-1', status: 'queued', alreadyRunning: false });
    expect(cskh.runAuditJob).not.toHaveBeenCalled();
  });

  it('không tạo job thứ 2 khi cron vừa xếp hàng job queued', async () => {
    cskh.findActiveJob.mockResolvedValue({ id: 'job-cron', status: 'queued' });

    const res = await controller.runAudit(user, body);

    expect(cskh.createJob).not.toHaveBeenCalled();
    expect(redisQueue.enqueueAuditJob).not.toHaveBeenCalled();
    expect(res).toMatchObject({ jobId: 'job-cron', status: 'queued', alreadyRunning: true });
  });

  it('không dùng findRunningJob nữa (bỏ sót job queued → chấm song song)', async () => {
    await controller.runAudit(user, body);

    expect(cskh.findRunningJob).not.toHaveBeenCalled();
    expect(cskh.findActiveJob).toHaveBeenCalledWith('audit', 't1');
  });

  it('Redis tắt: chạy inline trên API và báo đúng trạng thái running', async () => {
    redisQueue.enqueueAuditJob.mockResolvedValue(false);

    const res = await controller.runAudit(user, body);

    expect(cskh.runAuditJob).toHaveBeenCalledWith('job-1', expect.objectContaining({ pageId: 'p1' }));
    expect(res).toMatchObject({ status: 'running' });
  });
});

describe('audit — đếm hội thoại đã chấm', () => {
  let service: CskhService;
  let queryRaw: jest.Mock;

  beforeEach(() => {
    queryRaw = jest.fn();
    service = Object.create(CskhService.prototype) as CskhService;
    Object.assign(service, { prisma: { $queryRaw: queryRaw }, graph });
  });

  it.each([
    ['có cả conversationId và PSID', [auditRow('c1', 'u1')], 1],
    [
      'có nhiều bản ghi chấm lại',
      [auditRow('c1', 'u1'), auditRow('c1', 'u1')],
      1,
    ],
    [
      'conversationId thay đổi nhưng cùng PSID',
      [auditRow('c1', 'u1'), auditRow('c2', 'u1')],
      1,
    ],
    [
      'bản ghi cũ chỉ có conversationId',
      [auditRow('c1', null), auditRow('c1', null)],
      1,
    ],
    ['bản ghi chỉ có PSID', [auditRow(null, 'u1'), auditRow(null, 'u1')], 1],
    [
      'bản ghi cũ liên kết được với PSID, không phụ thuộc thứ tự',
      [auditRow('c1', null), auditRow(null, 'u1'), auditRow('c1', 'u1')],
      1,
    ],
    [
      'nhiều hội thoại khác nhau và định danh có khoảng trắng',
      [
        auditRow(' c1 ', ' u1 ', ' p1 '),
        auditRow('c1', 'u1'),
        auditRow('c2', null),
        auditRow(null, 'u3'),
      ],
      3,
    ],
    [
      'không có định danh hợp lệ',
      [auditRow(null, null), auditRow(' ', ' ')],
      0,
    ],
  ])('%s', async (_label, rows, expectedCount) => {
    queryRaw.mockResolvedValue(rows);

    const index = await service['loadAuditedConversationIndex'](
      '2026-09-13',
      '2026-09-13',
      ['p1'],
    );

    expect(index.countsByPage.get('p1') ?? 0).toBe(expectedCount);
  });

  it('giữ cả hai cách nhận diện để không chấm lại cuộc cũ', async () => {
    queryRaw.mockResolvedValue([auditRow('c1', 'u1')]);
    const index = await service['loadAuditedConversationIndex'](
      '2026-09-13',
      '2026-09-13',
      ['p1'],
    );

    expect(
      service['isConversationAlreadyAudited'](
        index.keys,
        'p1',
        conversation('p1', 'c1', 'u2'),
      ),
    ).toBe(true);
    expect(
      service['isConversationAlreadyAudited'](
        index.keys,
        'p1',
        conversation('p1', 'c2', 'u1'),
      ),
    ).toBe(true);
    expect(
      service['isConversationAlreadyAudited'](
        index.keys,
        'p1',
        conversation('p1', 'c2', 'u2'),
      ),
    ).toBe(false);
  });

  it('đếm độc lập theo kênh, kể cả khi hai kênh trùng định danh', async () => {
    queryRaw.mockResolvedValue([
      auditRow('c1', 'u1'),
      auditRow('c1', 'u1', 'p2'),
    ]);

    const index = await service['loadAuditedConversationIndex'](
      '2026-09-13',
      '2026-09-13',
      ['p1', 'p2'],
    );

    expect(index.countsByPage.get('p1')).toBe(1);
    expect(index.countsByPage.get('p2')).toBe(1);
  });

  it('không truy vấn DB khi không có kênh', async () => {
    const index = await service['loadAuditedConversationIndex'](
      '2026-09-13',
      '2026-09-13',
      [],
    );

    expect(index.keys.size).toBe(0);
    expect(index.countsByPage.size).toBe(0);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('audit — chạy tiếp theo giới hạn mỗi kênh', () => {
  function build(pageIds: string[], auditedCount = 25) {
    const service = Object.create(CskhService.prototype) as CskhService;
    const history = pageIds.flatMap((pageId) =>
      Array.from({ length: auditedCount }, (_, i) =>
        auditRow(`old-${i}`, `old-u-${i}`, pageId),
      ),
    );
    const queryRaw = jest.fn().mockResolvedValue(history);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const finishJob = jest.fn().mockResolvedValue(undefined);
    const auditChat = jest
      .fn()
      .mockResolvedValue({ id: 'audit-new', score: 80 });
    const fetch = jest.fn(
      async (
        ...args: Parameters<CskhService['fetchConversationsForAuditFromDb']>
      ) => {
        const [pageId, , , , , filter, cap, onMatch] = args;
        const candidates = [
          ...Array.from({ length: auditedCount }, (_, i) =>
            conversation(pageId, `old-${i}`, `old-u-${i}`),
          ),
          ...Array.from({ length: 50 }, (_, i) =>
            conversation(pageId, `new-${i}`, `new-u-${i}`),
          ),
        ];
        const picked: FbConversation[] = [];
        for (const conv of candidates) {
          if (filter?.(conv) === 'exclude') continue;
          picked.push(conv);
          await onMatch?.(conv);
          if (cap && picked.length >= cap) break;
        }
        return picked;
      },
    );

    Object.assign(service, {
      prisma: {
        $queryRaw: queryRaw,
        $executeRaw: executeRaw,
        cskhJobRun: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ status: 'running', tenantId: null }),
        },
      },
      graph,
      activeJobs: new Map(),
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      allPages: jest
        .fn()
        .mockResolvedValue(
          pageIds.map((pageId) => ({
            pageId,
            pageName: pageId,
            pageAccessToken: '',
          })),
        ),
      loadInboxAdMaps: jest.fn().mockResolvedValue(new Map()),
      shouldStopAuditJob: jest.fn().mockResolvedValue(false),
      shouldAbortAuditFetch: jest.fn().mockResolvedValue(false),
      waitForInboxUnlessAuditStopped: jest.fn().mockResolvedValue(true),
      isAuditJobCancelled: jest.fn().mockResolvedValue(false),
      fetchConversationsForAuditFromDb: fetch,
      finishJob,
      aiService: { resetAuditBatchCaches: jest.fn(), auditChat },
      inboxService: { autoLinkAndSync: jest.fn().mockResolvedValue(undefined) },
      auditConcurrency: 1,
      auditPageConcurrency: 1,
      auditSource: 'database',
      auditMsgLimit: 300,
      auditAiTranscriptMax: 120,
      auditMax: 0,
    });
    return { service, fetch, auditChat, finishJob, executeRaw, queryRaw };
  }

  it.each([
    ['một kênh', ['p1'], 'p1'],
    ['tất cả kênh', ['p1', 'p2'], undefined],
  ])(
    'đã chấm 25/50 cuộc: chấm thêm đúng 25 cuộc/kênh khi chọn %s',
    async (_label, pageIds, pageId) => {
      const { service, fetch, auditChat, finishJob, executeRaw } =
        build(pageIds);

      await service.runAuditJob('job-1', {
        auditDate: '2026-09-13',
        pageId,
        maxConversations: 50,
      });

      expect(fetch).toHaveBeenCalledTimes(pageIds.length);
      expect(fetch.mock.calls.map((call) => call[6])).toEqual(
        pageIds.map(() => 25),
      );
      expect(auditChat).toHaveBeenCalledTimes(25 * pageIds.length);
      expect(
        auditChat.mock.calls.every(([data]) =>
          data.metadata.conversationId.startsWith('new-'),
        ),
      ).toBe(true);
      expect(finishJob).toHaveBeenCalledWith(
        'job-1',
        'done',
        expect.objectContaining({
          audited: 25 * pageIds.length,
          processed: 25 * pageIds.length,
          skippedAlready: 25 * pageIds.length,
        }),
      );
      if (pageId) {
        const initialSummary = JSON.parse(executeRaw.mock.calls[0][1]);
        expect(initialSummary.alreadyAudited).toBe(25);
      }
    },
  );

  it('đã đủ 50 cuộc thì không chấm thêm', async () => {
    const { service, fetch, auditChat, finishJob } = build(['p1'], 50);

    await service.runAuditJob('job-1', {
      auditDate: '2026-09-13',
      pageId: 'p1',
      maxConversations: 50,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(auditChat).not.toHaveBeenCalled();
    expect(finishJob).toHaveBeenCalledWith(
      'job-1',
      'done',
      expect.objectContaining({ allAlreadyAudited: true, skippedAlready: 50 }),
    );
  });

  it('force=true vẫn cho phép chấm lại đủ giới hạn', async () => {
    const { service, fetch, auditChat, queryRaw, finishJob } = build(['p1']);

    await service.runAuditJob('job-1', {
      auditDate: '2026-09-13',
      pageId: 'p1',
      maxConversations: 50,
      force: true,
    });

    expect(queryRaw).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][6]).toBe(50);
    expect(auditChat).toHaveBeenCalledTimes(50);
    expect(finishJob).toHaveBeenCalledWith(
      'job-1',
      'done',
      expect.objectContaining({ audited: 50, skippedAlready: 0 }),
    );
  });
});
