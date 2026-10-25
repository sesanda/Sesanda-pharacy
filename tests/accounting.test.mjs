// Accounting engine tests — reversals, returns, opening balances, health check. SYNTHETIC fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers } from './_extract.mjs';
const H = loadHelpers(['glToCents','glCentsToAmount','glIsLiveJournal','findGlAccountByCode','checkJournalInvariants',
  'glActivePostedJournals','glLineDelta','computeTrialBalance','validateTrialBalance','computeProfitAndLoss',
  'computeBalanceSheet','validateBalanceSheet','glAgeInDays','glAgingBucket','glSubledgerLines','glARPaidByInvoice',
  'glAPPaidByGrn','computeAR','computeAP','invoiceBalanceInfo','computeCustomerOutstanding',
  'buildSalesReturnLines','buildOpeningBalanceLines','computeAccountsHealth','customerUsuallyBuysOnCredit','buildBillToCreditLines','buildGrnReturnLines','itemSellPrice','restockBatchFields','glCardBankCode','glBankAccounts']);

const CHART = [
  ['1000','Cash','ASSET'], ['1010','Bank','ASSET'], ['1100','Accounts Receivable','ASSET'], ['1210','Pharmacy Inventory','ASSET'],
  ['2100','Supplier Payables','LIABILITY'], ['3000','Owner Capital','EQUITY'], ['4000','Sales Revenue','REVENUE'],
  ['5000','Cost of Goods Sold','COGS'], ['6600','Other Expenses','EXPENSE'],
].map(([accountCode, accountName, accountType])=> ({ id:'a'+accountCode, accountCode, accountName, accountType, isActive:true }));
const A = code => 'a'+code;
const line = (code, debit, credit)=> ({ accountId:A(code), debit, credit });
let seq = 0;
const J = (sourceType, sourceId, lines, extra={})=> ({ id:'j'+(++seq), journalNo:'JE-'+String(seq).padStart(3,'0'), date:'2026-10-10', status:'POSTED', sourceType, sourceId, lines, ...extra });
const reverse = (j)=> [{ ...j, status:'REVERSED' }, J(j.sourceType, j.sourceId, j.lines.map(l=>({ ...l, debit:l.credit, credit:l.debit })), { reversalOfJournalId:j.id, date:'2026-10-12' })];
const balOf = (tb, code)=> { const r = tb.rows.find(x=>x.accountCode===code); return r ? r.debit - r.credit : 0; };

test('a reversed journal and its reversal net to zero (no double subtraction)', ()=>{
  const sale = J('SALE','inv1',[ line('1100',1000,0), line('4000',0,1000), line('5000',600,0), line('1210',0,600) ]);
  const journals = reverse(sale);
  const tb = H.computeTrialBalance(CHART, journals, '2026-12-31');
  for(const code of ['1100','4000','5000','1210']) assert.equal(balOf(tb, code), 0, code);
  assert.equal(H.validateTrialBalance(tb.rows).balanced, true);
  const pnl = H.computeProfitAndLoss(CHART, journals, '2026-01-01', '2026-12-31');
  assert.equal(pnl.revenue.total, 0); assert.equal(pnl.netProfit, 0);
  assert.equal(H.validateBalanceSheet(H.computeBalanceSheet(CHART, journals, '2026-12-31')).balanced, true);
});

test('glIsLiveJournal: only POSTED non-reversal journals are a source document\'s live entry', ()=>{
  const j = J('SALE','x',[]);
  const [orig, rev] = reverse(j);
  assert.equal(H.glIsLiveJournal(j), true);
  assert.equal(H.glIsLiveJournal(orig), false);
  assert.equal(H.glIsLiveJournal(rev), false);
  assert.equal(H.glIsLiveJournal({ ...j, status:'DRAFT' }), false);
});

test('a reversed customer payment no longer counts as paid on the bill', ()=>{
  const sale = J('SALE','inv1',[ line('1100',1000,0), line('4000',0,1000) ]);
  const pay = J('CUSTOMER_PAYMENT','p1',[ line('1000',400,0), line('1100',0,400) ]);
  const invoices = [{ id:'inv1', billNo:'B1', customerId:'c1', customerName:'Alpha' }];
  const payments = [{ id:'p1', customerId:'c1', customerName:'Alpha', amount:400, appliedTo:[{ billNo:'B1', applied:400 }] }];
  const before = H.computeAR(CHART, [sale, pay], invoices, payments, '2026-12-31', []);
  assert.equal(before.details[0].outstanding, 600);
  const after = H.computeAR(CHART, [sale, ...reverse(pay)], invoices, payments, '2026-12-31', []);
  assert.equal(after.details[0].outstanding, 1000);
  assert.equal(after.glBalance, 1000);
});

test('sales return lines: revenue down, AR / cash refund down, restocked cost back to inventory', ()=>{
  const lines = H.buildSalesReturnLines({ dueReduction:300, cashRefund:0, restockCost:120, payment:'credit', desc:'r' }, CHART);
  assert.deepEqual(lines.map(l=>[l.accountId, l.debit, l.credit]), [[A('4000'),300,0],[A('1100'),0,300],[A('1210'),120,0],[A('5000'),0,120]]);
  assert.deepEqual(H.checkJournalInvariants(lines, CHART), []);
  const card = H.buildSalesReturnLines({ dueReduction:50, cashRefund:200, restockCost:0, payment:'card', desc:'r' }, CHART);
  assert.deepEqual(card.map(l=>[l.accountId, l.debit, l.credit]), [[A('4000'),250,0],[A('1100'),0,50],[A('1010'),0,200]]);
  assert.deepEqual(H.checkJournalInvariants(card, CHART), []);
  assert.throws(()=> H.buildSalesReturnLines({ dueReduction:0, cashRefund:0, restockCost:0, desc:'r' }, CHART));
});

test('a posted sales return reduces the bill\'s outstanding in Accounts Receivable', ()=>{
  const sale = J('SALE','inv1',[ line('1100',1000,0), line('4000',0,1000) ]);
  const ret = J('SALES_RETURN','sr1', H.buildSalesReturnLines({ dueReduction:250, cashRefund:0, restockCost:0, desc:'r' }, CHART));
  const ar = H.computeAR(CHART, [sale, ret], [{ id:'inv1', billNo:'B1', customerId:'c1', customerName:'Alpha' }], [], '2026-12-31',
    [{ id:'sr1', billNo:'B1', customerId:'c1', customerName:'Alpha' }]);
  assert.equal(ar.glBalance, 750);
  assert.equal(ar.customers[0].outstanding, 750);
  assert.equal(ar.details[0].outstanding, 750);
  assert.equal(ar.unallocatedTotal, 0);
});

test('a posted GRN return reduces what is owed on that GRN in Accounts Payable', ()=>{
  const grn = J('GRN','g1',[ line('1210',1000,0), line('2100',0,1000) ]);
  const ret = J('GRN_RETURN','gr1',[ line('2100',300,0), line('1210',0,300) ]);
  const ap = H.computeAP(CHART, [grn, ret], [{ id:'g1', grnNo:'GRN-1', supplierId:'s1', supplierName:'Supp' }], [], '2026-12-31',
    [{ id:'gr1', grnId:'g1', grnNo:'GRN-1', supplierId:'s1', supplierName:'Supp' }]);
  assert.equal(ap.glBalance, 700);
  assert.equal(ap.details[0].outstanding, 700);
  assert.equal(ap.suppliers[0].outstanding, 700);
});

test('opening-balance lines move the control account in the right direction against 3000', ()=>{
  const ar = H.buildOpeningBalanceLines('1100', 500, CHART, 'ob');
  assert.deepEqual(ar.map(l=>[l.accountId, l.debit, l.credit]), [[A('1100'),500,0],[A('3000'),0,500]]);
  const down = H.buildOpeningBalanceLines('1210', -200, CHART, 'ob');
  assert.deepEqual(down.map(l=>[l.accountId, l.debit, l.credit]), [[A('1210'),0,200],[A('3000'),200,0]]);
  const ap = H.buildOpeningBalanceLines('2100', 300, CHART, 'ob');
  assert.deepEqual(ap.map(l=>[l.accountId, l.debit, l.credit]), [[A('2100'),0,300],[A('3000'),300,0]]);
  for(const ls of [ar, down, ap]) assert.deepEqual(H.checkJournalInvariants(ls, CHART), []);
  assert.throws(()=> H.buildOpeningBalanceLines('1100', 0, CHART, 'ob'));
});

test('health check: books vs shop records, unposted documents and deleted-bill journals', ()=>{
  const journals = [
    J('SALE','inv1',[ line('1100',600,0), line('4000',0,600), line('5000',400,0), line('1210',0,400) ]),
    J('GRN','g1',[ line('1210',1000,0), line('2100',0,1000) ]),
    J('SALE','gone',[ line('1000',50,0), line('4000',0,50) ]),                       // its bill was deleted
  ];
  const d = {
    glAccounts: CHART, glJournals: journals,
    customers: [{ id:'c1', name:'Alpha' }],
    invoices: [
      { id:'inv1', billNo:'B1', customerId:'c1', payment:'credit', totalToPay:600, paidAmount:0, accountingStatus:'POSTED' },
      { id:'inv0', billNo:'B0', customerId:'c1', payment:'credit', totalToPay:200, paidAmount:0 },            // before accounting
      { id:'inv9', billNo:'B9', customerId:'c1', payment:'cash', totalToPay:90, paidAmount:90, accountingStatus:'FAILED' },
    ],
    grns: [{ id:'g1', grnNo:'GRN-1', payment:'credit', paid:false, totalAmount:1000, paidAmount:0, accountingStatus:'POSTED' }],
    batches: [{ id:'b1', remainingUnits:10, unitCost:60 }, { id:'b2', remainingUnits:5, unitCost:60 }, { id:'b3', remainingUnits:4, unitCost:10, writtenOff:true }],
    payments: [], supplierPayments: [], salesReturns: [{ id:'sr1', billNo:'B1', glReturn:{ dueReduction:20, cashRefund:0 }, accountingStatus:'FAILED' }], grnReturns: [],
  };
  const h = H.computeAccountsHealth(d, '2026-12-31');
  assert.equal(h.trialBalance.balanced, true);
  assert.equal(h.balanceSheet.balanced, true);
  const c = Object.fromEntries(h.control.map(x=>[x.code, x]));
  assert.deepEqual([c['1100'].books, c['1100'].shop, c['1100'].diff], [600, 800, 200]);
  assert.deepEqual([c['1210'].books, c['1210'].shop, c['1210'].diff], [600, 900, 300]);
  assert.deepEqual([c['2100'].books, c['2100'].shop, c['2100'].diff], [1000, 1000, 0]);
  assert.equal(h.cash, 50);
  assert.deepEqual(h.unposted.bills.never.map(x=>x.id), ['inv0']);
  assert.deepEqual(h.unposted.bills.failed.map(x=>x.id), ['inv9']);
  assert.equal(h.unposted.bills.neverAmount, 200);
  assert.deepEqual(h.unposted.salesReturns.failed.map(x=>x.id), ['sr1']);
  assert.deepEqual(h.orphans.map(j=>j.sourceId), ['gone']);
  // after the opening-balance entries the control accounts match
  const ob = [J('OPENING_BALANCE','1100-x', H.buildOpeningBalanceLines('1100', 200, CHART, 'ob')), J('OPENING_BALANCE','1210-x', H.buildOpeningBalanceLines('1210', 300, CHART, 'ob'))];
  const h2 = H.computeAccountsHealth({ ...d, glJournals:[...journals, ...ob] }, '2026-12-31');
  assert.ok(h2.control.every(x=> Math.abs(x.diff) < 0.01));
  assert.equal(h2.balanceSheet.balanced, true);
});

test('zero-value documents are not listed as unposted; opening balances are detected', ()=>{
  const base = { glAccounts: CHART, glJournals: [], customers: [], grns: [], batches: [], supplierPayments: [], salesReturns: [], grnReturns: [] };
  const h = H.computeAccountsHealth({ ...base,
    invoices: [{ id:'z', totalToPay:0, accountingStatus:'FAILED' }, { id:'b', totalToPay:50, accountingStatus:'FAILED' }],
    payments: [{ id:'p', amount:0.0000001, accountingStatus:'FAILED' }] }, '2026-12-31');
  assert.deepEqual(h.unposted.bills.failed.map(x=>x.id), ['b']);
  assert.equal(h.unposted.customerPayments.failed.length, 0);
  assert.equal(h.openingPosted, false);
  const ob = J('OPENING_BALANCE','1100-x', H.buildOpeningBalanceLines('1100', 10, CHART, 'ob'));
  assert.equal(H.computeAccountsHealth({ ...base, invoices:[], payments:[], glJournals:[ob] }, '2026-12-31').openingPosted, true);
});

test('customerUsuallyBuysOnCredit: owes now, or at least half of the last 10 bills on credit', ()=>{
  const c = { id:'c1' };
  const bill = (i, payment, extra={})=> ({ id:'b'+i, customerId:'c1', payment, totalToPay:100, paidAmount: payment==='credit'?100:100, paid:true, createdAtMs:i, ...extra });
  assert.equal(H.customerUsuallyBuysOnCredit(null, []), false);
  assert.equal(H.customerUsuallyBuysOnCredit(c, []), false);
  assert.equal(H.customerUsuallyBuysOnCredit(c, [bill(1,'credit',{ paidAmount:0, paid:false })]), true);     // still owes
  assert.equal(H.customerUsuallyBuysOnCredit(c, [bill(1,'cash'), bill(2,'cash'), bill(3,'credit')]), false); // 1 of 3
  assert.equal(H.customerUsuallyBuysOnCredit(c, [bill(1,'cash'), bill(2,'credit'), bill(3,'credit')]), true);// 2 of 3, all settled
  assert.equal(H.customerUsuallyBuysOnCredit(c, [bill(1,'credit',{ totalToPay:0 })]), false);                 // zero bills ignored
});

test('bill-to-credit lines move the paid amount from Cash/Bank to AR', ()=>{
  const cash = H.buildBillToCreditLines({ id:'i', billNo:'B', payment:'cash', totalToPay:500, paidAmount:500 }, CHART);
  assert.deepEqual(cash.map(l=>[l.accountId, l.debit, l.credit]), [[A('1100'),500,0],[A('1000'),0,500]]);
  const card = H.buildBillToCreditLines({ id:'i', billNo:'B', payment:'card', totalToPay:500, paidAmount:200 }, CHART);
  assert.deepEqual(card.map(l=>[l.accountId, l.debit, l.credit]), [[A('1100'),200,0],[A('1010'),0,200]]);
  assert.throws(()=> H.buildBillToCreditLines({ id:'i', payment:'cash', totalToPay:100, paidAmount:0 }, CHART));
});

test('GRN return lines: inventory out at cost, supplier credit at its value, difference as gain/loss', ()=>{
  const chart = [...CHART, { id:'a4100', accountCode:'4100', accountName:'Other Income', accountType:'REVENUE', isActive:true }];
  const at = (ret)=> H.buildGrnReturnLines(ret, chart, 'r').map(l=>[l.accountId, l.debit, l.credit]);
  assert.deepEqual(at({ amount:300 }), [[A('2100'),300,0],[A('1210'),0,300]]);                       // old returns: credit = cost
  assert.deepEqual(at({ amount:500, cost:300 }), [[A('2100'),500,0],[A('1210'),0,300],['a4100',0,200]]);
  assert.deepEqual(at({ amount:250, cost:300 }), [[A('2100'),250,0],[A('1210'),0,300],[A('6600'),50,0]]);
  for(const ret of [{ amount:500, cost:300 }, { amount:250, cost:300 }])
    assert.deepEqual(H.checkJournalInvariants(H.buildGrnReturnLines(ret, chart, 'r'), chart), []);
});

test('itemSellPrice: FEFO batch price, else the latest priced batch (restocked units never bill at 0)', ()=>{
  const batches = [
    { id:'ret', itemId:'i', remainingUnits:2, unitSell:0, expiryDate:'' },                          // returned stock, no price
    { id:'b1', itemId:'i', remainingUnits:5, unitSell:12.5, expiryDate:'2027-01-01', createdAt:{ seconds:1 } },
    { id:'b2', itemId:'i', remainingUnits:0, unitSell:14, expiryDate:'2027-06-01', createdAt:{ seconds:2 } },
  ];
  assert.equal(H.itemSellPrice('i', batches), 14);
  assert.equal(H.itemSellPrice('i', [batches[1]]), 12.5);
  assert.equal(H.itemSellPrice('x', batches), 0);
});

test('restockBatchFields: keeps the sold price and the source batch expiry', ()=>{
  const batches = [{ id:'b1', itemId:'i', batchCode:'A-1', unitSell:20, unitCost:12, expiryDate:'2027-03-01' }];
  assert.deepEqual(H.restockBatchFields({ itemId:'i', batchCode:'A-1', unitPrice:19, unitCost:12 }, batches), { unitSell:19, unitCost:12, expiryDate:'2027-03-01' });
  assert.deepEqual(H.restockBatchFields({ itemId:'i', batchCode:'?' }, batches, 11), { unitSell:20, unitCost:11, expiryDate:'' });
});

test('costPriceWarning flags a selling price equal to or below cost', ()=>{
  const { costPriceWarning } = loadHelpers(['costPriceWarning']);
  assert.equal(costPriceWarning(8, 10), null);
  assert.equal(costPriceWarning('', 10), null);            // not typed yet
  assert.equal(costPriceWarning(10, ''), null);
  assert.match(costPriceWarning(10, 10), /සමානයි/);
  assert.match(costPriceWarning('12', '10'), /අඩුයි/);
});

test('itemLastPrices: newest GRN cost, New Bill sell price, returns skipped', ()=>{
  const { itemLastPrices } = loadHelpers(['itemSellPrice','itemLastPrices']);
  const batches = [
    { itemId:'i1', unitCost:8, unitSell:10, remainingUnits:0, grnNo:'GRN-1', createdAt:{seconds:1} },
    { itemId:'i1', unitCost:9, unitSell:12, remainingUnits:5, grnNo:'GRN-2', expiryDate:'2027-01-01', createdAt:{seconds:2} },
    { itemId:'i1', unitCost:7, unitSell:12, remainingUnits:1, isReturn:true, createdAt:{seconds:3} },
    { itemId:'i2', unitCost:5, unitSell:6, remainingUnits:1, isOpeningStock:true, grnNo:'' },
  ];
  assert.deepEqual(itemLastPrices('i1', batches), { unitCost:9, unitSell:12, grnNo:'GRN-2', expiryDate:'2027-01-01' });
  assert.equal(itemLastPrices('i2', batches).grnNo, 'Opening stock');
  assert.deepEqual([itemLastPrices('none', batches).unitCost, itemLastPrices('none', batches).unitSell], [0, 0]);
});

test('charts: buckets, sales trend, top items, payment mix, expiry value', ()=>{
  const C = loadHelpers(['chartBuckets','buildSalesTrend','buildTopItems','buildPaymentMix','buildExpiryValue']);
  assert.equal(C.chartBuckets('2026-10-01','2026-10-30').buckets.length, 30);
  assert.deepEqual(C.chartBuckets('2025-11-15','2026-10-25').buckets.map(b=>b.key).slice(0,3), ['2025-11','2025-12','2026-01']);
  assert.equal(C.chartBuckets('2025-11-15','2026-10-25').unit, 'month');
  const invs = [
    { totalToPay:100, payment:'cash', day:'2026-10-02', items:[{ itemId:'a', brandName:'A', qty:2, lineTotal:100, costTotal:60 }] },
    { totalToPay:50, payment:'credit', day:'2026-10-02', items:[{ itemId:'b', brandName:'B', qty:1, lineTotal:50, costTotal:20 }] },
    { totalToPay:30, payment:'card', day:'2026-10-03', items:[{ itemId:'a', brandName:'A', qty:1, lineTotal:30, costTotal:30 }] },
    { totalToPay:999, payment:'cash', day:'2026-09-01', items:[] },
  ];
  const t = C.buildSalesTrend(invs, [{ date:'2026-10-03', refundAmount:10, costImpact:6 }], '2026-10-01', '2026-10-03', i=>i.day, l=>l.costTotal);
  assert.deepEqual(t.rows.map(r=>[r.key, r.sales, r.cost, r.profit, r.bills]),
    [['2026-10-01',0,0,0,0], ['2026-10-02',150,80,70,2], ['2026-10-03',20,24,-4,1]]);
  const top = C.buildTopItems(invs.slice(0,3), l=>l.costTotal, 'profit', 5);
  assert.deepEqual(top.map(r=>[r.name, r.sales, r.profit, r.qty]), [['A',130,40,3], ['B',50,30,1]]);
  assert.deepEqual(C.buildPaymentMix(invs.slice(0,3)).map(r=>[r.key, r.value]), [['cash',100],['card',30],['credit',50]]);
  const ex = C.buildExpiryValue([
    { remainingUnits:10, unitCost:2, expiryDate:'2026-09-30' }, { remainingUnits:5, unitCost:4, expiryDate:'2026-11-20' },
    { remainingUnits:0, unitCost:4, expiryDate:'2026-11-20' }, { remainingUnits:5, unitCost:4, expiryDate:'2028-01-01' }], '2026-10-25', 3);
  assert.deepEqual(ex.map(r=>[r.key, r.value]), [['expired',20],['2026-10',0],['2026-11',20],['2026-12',0]]);
});

test('item analysis: price history, monthly units, generic comparison', ()=>{
  const C = loadHelpers(['localDateStr','buildItemPriceHistory','buildItemMonthlyUnits','buildGenericComparison']);
  const hist = C.buildItemPriceHistory('a', [
    { itemId:'a', unitCost:10, unitSell:12, grnId:'g2', grnNo:'GRN-2' },
    { itemId:'a', unitCost:8, unitSell:11, isOpeningStock:true, openingDate:'2026-01-05' },
    { itemId:'a', unitCost:9, unitSell:12, isReturn:true, openingDate:'2026-02-01' },
    { itemId:'b', unitCost:1, unitSell:2, openingDate:'2026-01-01' },
  ], [{ id:'g2', date:'2026-06-10' }]);
  assert.deepEqual(hist.map(p=>[p.date, p.unitCost, p.unitSell, p.source]), [['2026-01-05',8,11,'Opening stock'], ['2026-06-10',10,12,'GRN-2']]);
  const invs = [
    { day:'2026-10-02', items:[{ itemId:'a', qty:3, lineTotal:36, costTotal:30 }, { itemId:'b', qty:5, lineTotal:10, costTotal:5 }] },
    { day:'2026-08-15', items:[{ itemId:'a', qty:2, lineTotal:24, costTotal:20 }] },
    { day:'2025-01-01', items:[{ itemId:'a', qty:99, lineTotal:1, costTotal:1 }] },
  ];
  const mu = C.buildItemMonthlyUnits('a', invs, i=>i.day, '2026-10-25', 3);
  assert.deepEqual(mu.map(r=>[r.key, r.units, r.sales]), [['2026-08',2,24], ['2026-09',0,0], ['2026-10',3,36]]);
  const items = [{ id:'a', brandName:'A', genericName:'Paracetamol' }, { id:'b', brandName:'B', genericName:'paracetamol ' }, { id:'c', brandName:'C', genericName:'Other' }];
  const cmp = C.buildGenericComparison('PARACETAMOL', items, invs.slice(0,2), l=>l.costTotal);
  assert.deepEqual(cmp.map(r=>[r.name, r.units, r.sales, r.profit]), [['A',5,60,10], ['B',5,10,5]]);
});

test('card charges: fee, lines, and which card bills / payments still need one', ()=>{
  const C = loadHelpers(['glToCents','glIsLiveJournal','findGlAccountByCode','localDateStr','glDocDate','invoiceBalanceInfo','cardChargeAmount','buildCardChargeLines','pendingCardCharges','glCardBankCode','glBankAccounts']);
  assert.equal(C.cardChargeAmount(1000, 3), 30);
  assert.equal(C.cardChargeAmount(333.33, 2.5), 8.33);
  const chart = [{ id:'a6500', accountCode:'6500', accountType:'EXPENSE', isActive:true }, { id:'a1010', accountCode:'1010', accountType:'ASSET', isActive:true }];
  assert.deepEqual(C.buildCardChargeLines(30, chart, 'x').map(l=>[l.accountId, l.debit, l.credit]), [['a6500',30,0],['a1010',0,30]]);
  assert.throws(()=> C.buildCardChargeLines(30, chart.slice(0,1), 'x'), /1010 Bank/);
  const J = (sourceType, sourceId)=> ({ status:'POSTED', sourceType, sourceId });
  const invs = [
    { id:'i1', billNo:'INV-1', payment:'card', totalToPay:1000, paidAmount:1000, date:'2026-10-01' },                   // pending, current %
    { id:'i2', billNo:'INV-2', payment:'card', totalToPay:500, paidAmount:500, cardChargePct:2, date:'2026-10-02' },   // pending, own %
    { id:'i3', payment:'card', totalToPay:500, paidAmount:500 },                                                        // charge already posted
    { id:'i4', payment:'cash', totalToPay:500, paidAmount:500 },                                                        // cash
    { id:'i5', payment:'card', totalToPay:500, paidAmount:500 },                                                        // sale not in books
    { id:'i6', payment:'card', totalToPay:500, paidAmount:500, cardChargePct:0 },                                       // 0% when saved
    { id:'i7', payment:'card', totalToPay:500, paidAmount:500 },                                                        // changed to credit
  ];
  const pays = [{ id:'p1', method:'card', amount:200, customerName:'Alpha', date:'2026-10-03' }, { id:'p2', method:'cash', amount:200 }];
  const js = [J('SALE','i1'), J('SALE','i2'), J('SALE','i3'), J('CARD_CHARGE','i3'), J('SALE','i4'), J('SALE','i6'), J('SALE','i7'), J('BILL_TO_CREDIT','i7'),
    J('CUSTOMER_PAYMENT','p1'), J('CUSTOMER_PAYMENT','p2')];
  assert.deepEqual(C.pendingCardCharges(invs, pays, js, 3).map(c=>[c.id, c.amount, c.pct, c.date]),
    [['i1',1000,3,'2026-10-01'], ['i2',500,2,'2026-10-02'], ['p1',200,3,'2026-10-03']]);
  assert.equal(C.pendingCardCharges(invs, pays, js, 0).length, 1);   // only INV-2's own 2%
});

test('bank accounts: list, next code, transfer lines, card bank per document', ()=>{
  const C = loadHelpers(['glToCents','findGlAccountByCode','glBankAccounts','nextBankAccountCode','buildBankTransferLines']);
  const chart = [{ id:'a1000', accountCode:'1000', accountType:'ASSET' }, { id:'a1010', accountCode:'1010', accountType:'ASSET' },
    { id:'a1012', accountCode:'1012', accountType:'ASSET', isBank:true }, { id:'a1100', accountCode:'1100', accountType:'ASSET' },
    { id:'a1013', accountCode:'1013', accountType:'ASSET', isBank:true, isActive:false }];
  assert.deepEqual(C.glBankAccounts(chart).map(a=>a.accountCode), ['1010','1012']);
  assert.equal(C.nextBankAccountCode(chart), '1011');
  assert.deepEqual(C.buildBankTransferLines('1000','1012', 500, chart, 'd').map(l=>[l.accountId, l.debit, l.credit]), [['a1012',500,0],['a1000',0,500]]);
  assert.throws(()=> C.buildBankTransferLines('1010','1010', 5, chart, 'd'), /එකම account/);
  assert.throws(()=> C.buildBankTransferLines('1000','1010', 0, chart, 'd'), /0ට වඩා/);
  const { glCardBankCode } = loadHelpers(['glCardBankCode']);
  assert.equal(glCardBankCode({ cardBankCode:'1012' }), '1012');
  assert.equal(glCardBankCode({}), '1010');
});
