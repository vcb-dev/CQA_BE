/**
 * CLI: kéo data Sapo → DB.
 * Usage: npm run sapo:sync -- [all|products|customers|orders|collections]
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { SapoFullSyncService, type SapoSyncResource } from '../src/cskh/sapo/sapo-full-sync.service';

async function main() {
  const resource = (process.argv[2] ?? 'all').trim().toLowerCase() as SapoSyncResource;
  const allowed: SapoSyncResource[] = ['all', 'products', 'customers', 'orders', 'collections'];
  if (!allowed.includes(resource)) {
    console.error(`Usage: npm run sapo:sync -- <${allowed.join('|')}>`);
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const sync = app.get(SapoFullSyncService);
    const result = await sync.sync(resource);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
