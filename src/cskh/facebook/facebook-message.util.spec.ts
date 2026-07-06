import {
  normalizeFbMessage,
  resolveMessengerCustomerPsid,
  isMessengerFromCustomer,
} from './facebook-message.util';

describe('resolveMessengerCustomerPsid', () => {
  const pageId = '111';
  const customer = '222';
  const agent = '333';

  it('customer → page: sender is customer', () => {
    expect(
      resolveMessengerCustomerPsid(customer, pageId, pageId, {}),
    ).toBe(customer);
    expect(isMessengerFromCustomer(customer, customer)).toBe(true);
  });

  it('page → customer via echo', () => {
    const psid = resolveMessengerCustomerPsid(pageId, customer, pageId, { isEcho: true });
    expect(psid).toBe(customer);
    expect(isMessengerFromCustomer(pageId, customer)).toBe(false);
  });

  it('agent → customer (Business Suite): recipient is customer', () => {
    const psid = resolveMessengerCustomerPsid(agent, customer, pageId, {});
    expect(psid).toBe(customer);
    expect(isMessengerFromCustomer(agent, customer)).toBe(false);
  });

  it('uses known participantPsid when set', () => {
    expect(
      resolveMessengerCustomerPsid(agent, customer, pageId, {
        participantPsid: customer,
      }),
    ).toBe(customer);
  });
});

describe('normalizeFbMessage sender', () => {
  const pageId = '2497800676910664';
  const customerPsid = '1234567890';
  const pageAgentPsid = '9999999999';

  it('classifies customer PSID as Customer', () => {
    const n = normalizeFbMessage(
      { from: { id: customerPsid }, message: 'Cho em xin giá' },
      pageId,
      customerPsid,
    );
    expect(n?.sender).toBe('Customer');
  });

  it('classifies page agent PSID as Staff when customerPsid is known', () => {
    const n = normalizeFbMessage(
      {
        from: { id: pageAgentPsid },
        message: 'Bên em cam kết chất liệu chuẩn bạc/ vàng 100%',
      },
      pageId,
      customerPsid,
    );
    expect(n?.sender).toBe('Staff');
  });

  it('without customerPsid, only pageId is Staff (legacy fallback)', () => {
    const staff = normalizeFbMessage(
      { from: { id: pageId }, message: 'Shop reply' },
      pageId,
    );
    const customer = normalizeFbMessage(
      { from: { id: pageAgentPsid }, message: 'Shop reply' },
      pageId,
    );
    expect(staff?.sender).toBe('Staff');
    expect(customer?.sender).toBe('Customer');
  });
});
