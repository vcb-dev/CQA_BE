/**
 * Đồng bộ Pancake: 1 page hoặc toàn bộ kênh chat.
 * npx ts-node -r tsconfig-paths/register scripts/sync-pancake-channels.ts
 * npx ts-node -r tsconfig-paths/register scripts/sync-pancake-channels.ts --page=igo_xxx
 * npx ts-node -r tsconfig-paths/register scripts/sync-pancake-channels.ts --all
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PancakeService } from '../src/pancake/pancake.service';

async function main() {
  const args = process.argv.slice(2);
  const pageArg = args.find((a) => a.startsWith('--page='))?.slice('--page='.length);
  const all = args.includes('--all') || !pageArg;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const pancake = app.get(PancakeService);

  try {
    if (pageArg) {
      console.log(`Sync page ${pageArg}…`);
      const r = await pancake.syncPageCustomers(pageArg);
      console.log(JSON.stringify(r, null, 2));
    }
    if (all) {
      console.log('Sync ALL chat pages…');
      const r = await pancake.syncAllPages();
      console.log(
        JSON.stringify(
          {
            totalPages: r.totalPages,
            ok: r.ok,
            failed: r.failed,
            results: r.results.slice(0, 30),
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
