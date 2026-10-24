// Accounting engine tests — reversals, returns, opening balances, health check. SYNTHETIC fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers } from './_extract.mjs';
const H = loadHelpers(['glToCents','glCentsToAmount','glIsLiveJournal','findGlAccountByCode','checkJournalInvariants',
  'glActivePostedJournals','glLineDelta','computeTrialBalance','validateTrialBalance','computeProfitAndLoss',
  'computeBalanceSheet','validateBalanceSheet','glAgeInDays','glAgingBucket','glSubledgerLines','glARPaidByInvoice',
  'glAPPaidByGrn','computeAR','computeAP','invoiceBalanceInfo','computeCustomerOutstanding',
  'buildSalesReturnLines','buildOpeningBalanceLines','computeAccountsHealth']);

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
