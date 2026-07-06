/**
 * Chạy:
 *   npx ts-node -r tsconfig-paths/register scripts/test-ad-insights-live.ts
 *   npx ts-node -r tsconfig-paths/register scripts/test-ad-insights-live.ts 2497800676910664 6
 * Tham số: [pageId] [số tài khoản QC quét]
 */
import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const GRAPH = 'https://graph.facebook.com/v21.0';

async function main() {
  const prisma = new PrismaClient();
  const pageIdArg = process.argv[2];
  const limit = Number(process.argv[3] || 6);

  try {
    const conv = pageIdArg
      ? await prisma.cskhInboxConversation.findFirst({
          where: { pageId: pageIdArg, fromAd: true },
          orderBy: { lastMessageAt: 'desc' },
          select: {
            id: true,
            pageId: true,
            pageName: true,
            customerName: true,
            adId: true,
            referralSource: true,
          },
        })
      : await prisma.cskhInboxConversation.findFirst({
          where: { fromAd: true },
          orderBy: { lastMessageAt: 'desc' },
          select: {
            id: true,
            pageId: true,
            pageName: true,
            customerName: true,
            adId: true,
            referralSource: true,
          },
        });

    if (!conv) {
      console.log('❌ Không có hội thoại fromAd trong DB');
      process.exit(1);
    }

    console.log('\n=== Hội thoại mẫu ===');
    console.log(JSON.stringify(conv, null, 2));

    const sessions = await prisma.facebookOAuthSession.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 3,
      select: { fbUserId: true, metadata: true, userAccessToken: true, updatedAt: true },
    });

    if (!sessions.length) {
      console.log('❌ Không có Facebook OAuth session');
      process.exit(1);
    }

    const token = sessions[0].userAccessToken;
    const meta = sessions[0].metadata as { adAccounts?: Array<{ id: string; name?: string }> } | null;
    let accounts = meta?.adAccounts ?? [];

    if (!accounts.length) {
      const res = await axios.get(`${GRAPH}/me/adaccounts`, {
        params: { fields: 'id,name,currency', limit: 20, access_token: token },
        timeout: 20_000,
      });
      accounts = res.data?.data ?? [];
    }

    console.log('\n=== Tài khoản QC OAuth ===');
    accounts.slice(0, limit).forEach((a) => console.log(`  - ${a.name || a.id} (${a.id})`));

    for (const account of accounts.slice(0, limit)) {
      if (!account.id) continue;
      console.log(`\n--- Page ${conv.pageName} (${conv.pageId}) × QC ${account.name || account.id} ---`);

      // Adsets promoted_object.page_id
      let adCount = 0;
      try {
        const adsetRes = await axios.get(`${GRAPH}/${account.id}/adsets`, {
          params: {
            fields: 'id,name,promoted_object',
            limit: 50,
            filtering: JSON.stringify([
              { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] },
            ]),
            access_token: token,
          },
          timeout: 25_000,
        });
        const adsets = adsetRes.data?.data ?? [];
        const matched = adsets.filter(
          (s: { promoted_object?: { page_id?: string } }) => s.promoted_object?.page_id === conv.pageId,
        );
        adCount = matched.length;
        console.log(`  Adsets gắn Page: ${matched.length}`);
        matched.slice(0, 3).forEach((s: { id: string; name?: string }) =>
          console.log(`    · adset ${s.name || s.id}`),
        );
      } catch (e) {
        console.log(`  Adsets lỗi: ${(e as Error).message}`);
      }

      if (adCount === 0) {
        console.log('  → Không thấy QC Click-to-Messenger cho Page này trên tài khoản này');
        continue;
      }

      // Insights messaging 30 ngày (nếu có ads)
      try {
        const adsRes = await axios.get(`${GRAPH}/${account.id}/ads`, {
          params: {
            fields: 'id,name,effective_status,creative{object_story_spec}',
            limit: 30,
            access_token: token,
          },
          timeout: 25_000,
        });
        const pageAdIds = (adsRes.data?.data ?? [])
          .filter((row: { creative?: { object_story_spec?: { page_id?: string; link_data?: { page_id?: string } } } }) => {
            const spec = row.creative?.object_story_spec;
            return spec?.page_id === conv.pageId || spec?.link_data?.page_id === conv.pageId;
          })
          .map((r: { id: string }) => r.id)
          .slice(0, 20);

        if (!pageAdIds.length) {
          console.log('  Ads creative match: 0 (chỉ có adset promoted_object)');
        } else {
          const insRes = await axios.get(`${GRAPH}/${account.id}/insights`, {
            params: {
              level: 'ad',
              fields: 'ad_id,spend,actions,cost_per_action_type,account_currency,date_start,date_stop',
              date_preset: 'last_30d',
              filtering: JSON.stringify([{ field: 'ad.id', operator: 'IN', value: pageAdIds }]),
              limit: 50,
              access_token: token,
            },
            timeout: 25_000,
          });
          const rows = insRes.data?.data ?? [];
          let spend = 0;
          let messaging = 0;
          for (const row of rows) {
            spend += Number(row.spend ?? 0);
            const actions = row.actions as Array<{ action_type?: string; value?: string }> | undefined;
            if (Array.isArray(actions)) {
              for (const a of actions) {
                if (a.action_type?.includes('messaging')) {
                  messaging += Number(a.value ?? 0);
                }
              }
            }
          }
          console.log(`  Insights rows: ${rows.length}`);
          console.log(`  Spend 30d: ${spend.toLocaleString('vi-VN')} ${rows[0]?.account_currency ?? ''}`);
          console.log(`  Messaging actions: ${messaging}`);
          if (messaging > 0 && spend > 0) {
            console.log(`  ✅ Chi phí TB/tin ≈ ${Math.round(spend / messaging).toLocaleString('vi-VN')}`);
          } else if (spend > 0) {
            console.log('  ⚠ Có chi tiêu nhưng Meta chưa trả số messaging (30 ngày)');
          } else {
            console.log('  ⚠ Chưa có insights chi tiêu');
          }
        }
      } catch (e) {
        console.log(`  Insights lỗi: ${(e as Error).message}`);
      }
    }

    if (conv.adId) {
      console.log(`\n=== Insights theo ad_id ${conv.adId} ===`);
      try {
        const adIns = await axios.get(`${GRAPH}/${conv.adId}/insights`, {
          params: {
            fields: 'spend,actions,cost_per_action_type,campaign_name,ad_name,account_currency',
            date_preset: 'last_30d',
            access_token: token,
          },
          timeout: 20_000,
        });
        console.log(JSON.stringify(adIns.data?.data?.[0] ?? adIns.data, null, 2));
      } catch (e) {
        console.log(`  Lỗi: ${(e as Error).message}`);
      }
    } else {
      console.log('\n(Tin không có ad_id — chỉ ước tính page-level)');
    }

    console.log('\n✅ Script hoàn tất\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
