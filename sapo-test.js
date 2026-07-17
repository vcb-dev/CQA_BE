const axios = require('axios');
require('dotenv').config();

async function testSapoConnection() {
  const store = (process.env.SAPO_STORE || 'vienchibao').replace(/^["']|["']$/g, '');
  const apiKey = process.env.SAPO_API_KEY || process.env.SAPO_PRIVATE_API_KEY;
  const apiSecret = process.env.SAPO_API_SECRET || process.env.SAPO_PRIVATE_API_SECRET;
  const accessToken = process.env.SAPO_ACCESS_TOKEN;

  console.log('--- Cấu hình Sapo đang sử dụng ---');
  console.log(`Cửa hàng (SAPO_STORE): ${store}.mysapo.net`);
  console.log(`API Key: ${apiKey ? 'Đã cấu hình' : 'CHƯA CẤU HÌNH'}`);
  console.log(`API Secret: ${apiSecret ? 'Đã cấu hình' : 'CHƯA CẤU HÌNH'}`);
  console.log(`Access Token: ${accessToken ? 'Đã cấu hình' : 'CHƯA CẤU HÌNH'}`);
  console.log('Endpoint: GET /admin/products.json');
  console.log('---------------------------------\n');

  const host = store.includes('mysapo.net') ? store : `${store}.mysapo.net`;
  const url = `https://${host}/admin/products.json`;

  const axiosConfig = accessToken
    ? {
        headers: { 'Content-Type': 'application/json', 'X-Sapo-Access-Token': accessToken },
      }
    : apiKey && apiSecret
      ? { auth: { username: apiKey, password: apiSecret }, headers: { 'Content-Type': 'application/json' } }
      : null;

  if (!axiosConfig) {
    console.error('❌ LỖI: Thiếu SAPO_ACCESS_TOKEN hoặc SAPO_API_KEY + SAPO_API_SECRET (Private App).');
    return;
  }

  console.log(`🔄 Đang thử kết nối tới Sapo API: ${url}...`);

  try {
    const response = await axios.get(url, {
      ...axiosConfig,
      params: { limit: 5 },
      timeout: 15000,
    });

    console.log('✅ KẾT NỐI SAPO THÀNH CÔNG!');
    const products = response.data.products || [];
    console.log(`Số lượng sản phẩm lấy thử: ${products.length}`);
    if (products.length > 0) {
      console.log('\nDanh sách 5 sản phẩm đầu tiên:');
      products.forEach((p, index) => {
        console.log(`${index + 1}. ${p.name || p.title} (ID: ${p.id}) - Tags: ${p.tags || 'Trống'}`);
      });
    } else {
      console.log('Cửa hàng chưa có sản phẩm nào.');
    }
  } catch (error) {
    console.error('❌ KẾT NỐI SAPO THẤT BẠI!');
    if (error.response) {
      console.error(`Status code: ${error.response.status}`);
      console.error('Chi tiết lỗi:', JSON.stringify(error.response.data));
    } else {
      console.error('Chi tiết lỗi:', error.message);
    }
  }
}

testSapoConnection();
