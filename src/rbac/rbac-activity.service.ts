import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

const FLUSH_INTERVAL_MS = 30_000; // gom ghi DB theo lô mỗi 30 giây

/**
 * Ghi mốc "Hoạt động cuối" vào cột DB `users.last_active_at`, gom theo lô.
 *
 * `RbacActivityInterceptor` gọi `markActive` ở MỌI request đã xác thực. Ghi
 * DB ngay lúc đó thì với nhiều nhân viên cùng hoạt động, các lượt `UPDATE`
 * dồn cụm tranh connection trong pool hẹp (dùng chung với warehouse-be).
 * Nên `markActive` chỉ ghi vào `Map` trong bộ nhớ (tức thời, không đụng DB);
 * cứ mỗi `FLUSH_INTERVAL_MS`, `flush()` gom hết user đang chờ, lọc bỏ user
 * không còn tồn tại (vd vừa bị xóa), rồi ghi cả lô trong 1 transaction —
 * giữ đúng 1 connection cho cả lô thay vì mỗi user tự giành 1 connection.
 */
@Injectable()
export class RbacActivityService implements OnModuleDestroy {
  private readonly logger = new Logger(RbacActivityService.name);
  /** userId → mốc hoạt động, chờ tới lượt flush kế tiếp. */
  private readonly pending = new Map<string, Date>();

  constructor(private readonly prisma: PrismaService) {}

  /** Không đụng DB — chỉ ghi vào bộ nhớ, cực rẻ. */
  markActive(userId: bigint | number | string): void {
    this.pending.set(String(userId), new Date());
  }

  @Interval(FLUSH_INTERVAL_MS)
  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = Array.from(this.pending.entries());
    this.pending.clear();

    try {
      const ids = batch.map(([id]) => BigInt(id));
      // Lọc bỏ user không còn tồn tại — tránh cả lô fail vì 1 id đã bị xóa.
      const existing = await this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });
      const existingIds = new Set(existing.map((u) => String(u.id)));
      const updates = batch.filter(([id]) => existingIds.has(id));
      if (updates.length === 0) return;

      await this.prisma.$transaction(
        updates.map(([id, at]) =>
          this.prisma.user.update({
            where: { id: BigInt(id) },
            data: { lastActiveAt: at },
          }),
        ),
      );
    } catch (e) {
      this.logger.warn(
        `flush ${batch.length} user lỗi: ${(e as Error).message}`,
      );
    }
  }

  /** Ghi nốt phần đang chờ trước khi server tắt — không thì mất mốc lượt cuối. */
  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }
}
