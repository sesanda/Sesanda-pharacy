// Browser test: Finance health check + a real sales return reaching the books. Loads the REAL
// index.html with tests/firebase-stub.js (stateful, in-memory) and SYNTHETIC fixtures only.
// Same TEST_DEPS requirement as customers-ui.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const DEPS = process.env.TEST_DEPS;
const HTML_FILE = process.env.TEST_HTML || path.join(here, '..', 'index.html');
const skip = !DEPS && 'TEST_DEPS not set — browser tests skipped';

const CHART = [['1000','Cash','ASSET'],['1010','Bank','ASSET'],['1100','Accounts Receivable','ASSET'],['1210','Pharmacy Inventory','ASSET'],
  ['2100','Supplier Payables','LIABILITY'],['3000','Owner Capital','EQUITY'],['4000','Sales Revenue','REVENUE'],['5000','Cost of Goods Sold','COGS']]
  .map(([accountCode, accountName, accountType])=> ({ id:'a'+accountCode, accountCode, accountName, accountType, isActive:true }));
const L = (code, debit, credit)=> ({ accountId:'a'+code, debit, credit, description:'' });
const fixture = { collections:{
  glAccounts: CHART,
  glJournals: [
    { id:'jg1', journalNo:'JE-1', date:'2026-10-01', status:'POSTED', sourceType:'GRN', sourceId:'g1', description:'GRN', lines:[L('1210',1800,0), L('2100',0,1800)] },
    { id:'js1', journalNo:'JE-2', date:'2026-10-02', status:'POSTED', sourceType:'SALE', sourceId:'inv1', description:'Bill B1', lines:[L('1100',1000,0), L('4000',0,1000), L('5000',600,0), L('1210',0,600)] },
  ],
  customers: [{ id:'c1', name:'Alpha Test', tel:'0770000001', dueAmount:1000 }],
  invoices: [{ id:'inv1', billNo:'B1', customerId:'c1', customerName:'Alpha Test', payment:'credit', totalToPay:1000, paidAmount:0, paid:false,
    accountingStatus:'POSTED', createdAtMs:1, items:[{ itemId:'it1', brandName:'Testamol', qty:10, unitPrice:100, lineTotal:1000, costTotal:600, unitCost:60, batchCode:'B-1' }] }],
  grns: [{ id:'g1', grnNo:'GRN-1', supplierId:'s1', supplierName:'Supp', payment:'credit', paid:false, totalAmount:1800, paidAmount:0, accountingStatus:'POSTED', date:'2026-10-01' }],
  batches: [{ id:'b1', itemId:'it1', brandName:'Testamol', remainingUnits:20, unitCost:60, unitSell:100, expiryDate:'2027-05-01', grnId:'g1', batchCode:'B-1' }],
  items: [{ id:'it1', brandName:'Testamol' }],
  salesReturns: [], grnReturns: [], payments: [], supplierPayments: [],
}};

async function signIn(){
  const req = createRequire(path.join(DEPS, 'x.js'));
  const { chromium } = req('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args:['--no-sandbox'] });
  const page = await browser.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', e=> errors.push(String(e)));
  // confirm() → OK; the admin-PIN prompt() gets the app's own PIN (read from index.html, never logged)
  const pin = (fs.readFileSync(HTML_FILE,'utf8').match(/const ADMIN_ACTION_PIN\s*=\s*['"]([^'"]*)['"]/)||[])[1] || '';
  page.on('dialog', d=> d.type()==='prompt' ? d.accept(pin) : d.accept());
  const stub = fs.readFileSync(path.join(here,'firebase-stub.js'),'utf8');
  const local = { 'react.production.min.js':'react/umd/react.production.min.js', 'react-dom.production.min.js':'react-dom/umd/react-dom.production.min.js', 'babel.min.js':'@babel/standalone/babel.min.js' };
  await page.route('**/*', async route=>{
    const url = route.request().url();
    if(url==='http://app.test/') return route.fulfill({ contentType:'text/html', body: fs.readFileSync(HTML_FILE,'utf8') });
    if(url.includes('firebase-app-compat')) return route.fulfill({ contentType:'text/javascript', body:'window.__FIXTURE__='+JSON.stringify(fixture)+';\n'+stub });
    for(const k of Object.keys(local)) if(url.endsWith(k)) return route.fulfill({ contentType:'text/javascript', body: fs.readFileSync(path.join(DEPS, local[k]),'utf8') });
    return route.fulfill({ contentType:'text/javascript', body:'' });
  });
  await page.goto('http://app.test/', { waitUntil:'commit' });
  await page.getByText('Staff / Admin Portal').waitFor({ timeout:60000 });
  await page.getByText('Staff / Admin Portal').click();
  const inputs = page.locator('input'); await inputs.nth(0).fill('t@example.test'); await inputs.nth(1).fill('x');
  await page.getByRole('button', { name:'Login' }).click();
  await page.getByText('Finance (Setup)', { exact:true }).first().waitFor();
  return { browser, page, errors };
}
const controlRows = async (page)=> (await page.getByTestId('health-control').innerText());

test('sales return posts to the books and the health check still matches the shop', { skip }, async()=>{
  const { browser, page, errors } = await signIn();
  try{
    await page.getByText('Finance (Setup)', { exact:true }).first().click();
    await page.getByTestId('health-check').waitFor();
    let t = await controlRows(page);
    assert.equal((t.match(/✓ matches/g)||[]).length, 3, t);

    await page.getByText('Returns', { exact:true }).first().click();
    await page.getByPlaceholder('Bill No (e.g. INV-1234)').fill('B1');
    await page.getByRole('button', { name:'🔍 Find Bill' }).click();
    await page.locator('input[type=number]').first().fill('2');
    await page.getByRole('button', { name:'↩️ Process Return' }).click();
    await page.waitForFunction(()=> (window.firebase.__store.glJournals||[]).some(j=> j.sourceType==='SALES_RETURN' && j.status==='POSTED'));
    const j = await page.evaluate(()=> window.firebase.__store.glJournals.find(j=> j.sourceType==='SALES_RETURN'));
    assert.deepEqual(j.lines.map(l=>[l.accountId, l.debit, l.credit]), [['a4000',200,0],['a1100',0,200],['a1210',120,0],['a5000',0,120]]);
    await page.waitForFunction(()=> (window.firebase.__store.salesReturns||[]).some(r=> r.accountingStatus==='POSTED'));
    const ret = await page.evaluate(()=> window.firebase.__store.batches.find(b=> b.isReturn));
    assert.deepEqual([ret.unitSell, ret.expiryDate, ret.remainingUnits], [100, '2027-05-01', 2]);   // bills again at its real price

    await page.getByText('Finance (Setup)', { exact:true }).first().click();
    t = await controlRows(page);
    assert.match(t, /1100[^\n]*Rs\. 800\.00\s+Rs\. 800\.00/);
    assert.equal((t.match(/✓ matches/g)||[]).length, 3, t);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('deleted bill: its sale entry is reversed in the books', { skip }, async()=>{
  const { browser, page, errors } = await signIn();
  try{
    await page.getByText('Reports', { exact:true }).first().click();
    await page.getByRole('button', { name:'🧾 Sales Report' }).click();
    await page.locator('input[type=date]').first().fill('1970-01-01');
    await page.getByTitle('Delete invoice (Admin PIN required)').first().click();
    await page.waitForFunction(()=> (window.firebase.__store.glJournals||[]).some(j=> j.id==='js1' && j.status==='REVERSED'));
    const rev = await page.evaluate(()=> window.firebase.__store.glJournals.find(j=> j.reversalOfJournalId==='js1'));
    assert.equal(rev.status, 'POSTED');
    assert.deepEqual(rev.lines.map(l=>[l.accountId, l.debit, l.credit]), [['a1100',0,1000],['a4000',1000,0],['a5000',0,600],['a1210',600,0]]);
    await page.getByText('Finance (Setup)', { exact:true }).first().click();
    const t = await page.getByTestId('health-check').innerText();
    assert.match(t, /Deleted bills\/GRNs still in the books: 0/);
    assert.match(t, /Trial Balance balanced/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('no Chart of Accounts yet: load it, Retry all posts failed bills/GRNs/payments on their own dates', { skip }, async()=>{
  const d1 = Date.UTC(2026, 8, 5, 6), d2 = Date.UTC(2026, 9, 1, 6);
  const fx = JSON.parse(JSON.stringify(fixture));
  fx.collections.glAccounts = []; fx.collections.glJournals = [];
  fx.collections.invoices = [
    { id:'inv1', billNo:'B1', customerId:'c1', customerName:'Alpha Test', payment:'credit', totalToPay:1000, paidAmount:0, paid:false, createdAtMs:d1,
      accountingStatus:'FAILED', accountingError:'Chart of Accounts has no active 4000 Sales Revenue account', items:[{ itemId:'it1', brandName:'Testamol', qty:10, lineTotal:1000, costTotal:600 }] },
    { id:'inv2', billNo:'B2', customerId:null, customerName:'NC', payment:'cash', totalToPay:300, paidAmount:300, paid:true, createdAtMs:d2,
      accountingStatus:'FAILED', items:[{ itemId:'it1', brandName:'Testamol', qty:3, lineTotal:300, costTotal:180 }] },
  ];
  fx.collections.grns = [{ ...fixture.collections.grns[0], accountingStatus:'FAILED', date:'2026-09-01' }];
  fx.collections.payments = [
    { id:'p1', customerId:'c1', customerName:'Alpha Test', amount:400, method:'cash', appliedTo:[{ billNo:'B1', applied:400 }], createdAtMs:d2, accountingStatus:'FAILED' },
    { id:'p0', customerId:'c1', customerName:'Alpha Test', amount:0, method:'cash', accountingStatus:'FAILED' },
  ];
  fx.collections.customers = [{ id:'c1', name:'Alpha Test', dueAmount:600 }];
  fx.collections.invoices[0].paidAmount = 400;
  const saved = fixture.collections; fixture.collections = fx.collections;
  const { browser, page, errors } = await signIn();
  fixture.collections = saved;
  try{
    await page.getByText('Finance (Setup)', { exact:true }).first().click();
    await page.getByText('Accounts are not set up yet').waitFor();
    await page.getByRole('button', { name:'🌱 Load default Chart of Accounts' }).click();
    await page.getByTestId('health-check').waitFor();
    await page.getByRole('button', { name:/Retry all failed \(4\)/ }).click();         // 1 GRN + 2 bills + 1 payment (the Rs 0 one is not listed)
    await page.waitForFunction(()=> (window.firebase.__store.glJournals||[]).filter(j=> j.status==='POSTED').length===4, null, { timeout:30000 });
    const js = await page.evaluate(()=> window.firebase.__store.glJournals.map(j=> [j.sourceType, j.sourceId, j.date]).sort());
    assert.deepEqual(js, [['CUSTOMER_PAYMENT','p1','2026-10-01'], ['GRN','g1','2026-09-01'], ['SALE','inv1','2026-09-05'], ['SALE','inv2','2026-10-01']]);
    await page.waitForFunction(()=> !document.body.innerText.includes('Posting '));
    const t = await page.getByTestId('health-check').innerText();
    assert.match(t, /Failed postings waiting for retry: 0/);
    assert.match(t, /Trial Balance balanced/);
    assert.match(t, /1100[^\n]*Rs\. 600\.00\s+Rs\. 600\.00/);                            // 1000 billed − 400 paid
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Retry all with many bills: runs side by side, each bill posted once, unique journal numbers', { skip }, async()=>{
  const fx = JSON.parse(JSON.stringify(fixture));
  fx.collections.glJournals = []; fx.collections.grns = []; fx.collections.customers = [];
  fx.collections.invoices = Array.from({length:60}, (_,i)=> ({ id:'iv'+i, billNo:'B'+i, customerId:null, customerName:'NC', payment:'cash',
    totalToPay:100+i, paidAmount:100+i, paid:true, createdAtMs: Date.UTC(2026, 9, 1+(i%20), 6), accountingStatus:'FAILED', items:[{ itemId:'it1', qty:1, lineTotal:100+i, costTotal:50 }] }));
  const saved = fixture.collections; fixture.collections = fx.collections;
  const { browser, page, errors } = await signIn();
  fixture.collections = saved;
  try{
    await page.getByText('Finance (Setup)', { exact:true }).first().click();
    await page.getByTestId('health-check').waitFor();
    await page.getByRole('button', { name:/Retry all failed \(60\)/ }).click();
    await page.waitForFunction(()=> (window.firebase.__store.glJournals||[]).filter(j=> j.status==='POSTED').length===60, null, { timeout:60000 });
    const js = await page.evaluate(()=> window.firebase.__store.glJournals);
    assert.equal(new Set(js.map(j=> j.sourceId)).size, 60);
    assert.equal(new Set(js.map(j=> j.journalNo)).size, 60);
    await page.waitForFunction(()=> /Failed postings waiting for retry: 0/.test(document.body.innerText));
    assert.match(await page.getByTestId('health-check').innerText(), /Trial Balance balanced/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('New Bill: a credit customer\'s bill saved as cash asks first; Cancel saves nothing', { skip }, async()=>{
  const { browser, page, errors } = await signIn();
  try{
    const dialogs = [];
    page.removeAllListeners('dialog');
    let answer = false;
    page.on('dialog', d=>{ dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });
    await page.getByText('New Bill', { exact:true }).first().click();
    await page.getByText('Use registered customer').first().click();
    await page.getByPlaceholder('Search customer name or tel...').fill('Alpha');
    await page.locator('.ac-item', { hasText:'Alpha Test' }).first().dispatchEvent('mousedown');
    await page.getByPlaceholder('type code or brand name...').fill('Testamol');
    await page.locator('.ac-item', { hasText:'Testamol' }).first().dispatchEvent('mousedown');
    await page.locator('input[type=number]').first().fill('1');
    await page.getByRole('button', { name:'+ Add' }).click();
    await page.getByRole('button', { name:'💾 Save Bill' }).click();
    await page.waitForTimeout(300);
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0], /Alpha Test සාමාන්‍යයෙන් ණයට/);
    assert.equal(await page.evaluate(()=> window.firebase.__store.invoices.length), 1);   // nothing saved
    answer = true;                                                                       // now confirm it really is cash
    await page.getByRole('button', { name:'💾 Save Bill' }).click();
    await page.waitForFunction(()=> window.firebase.__store.invoices.length===2);
    assert.equal(await page.evaluate(()=> window.firebase.__store.invoices.find(i=> i.id!=='inv1').payment), 'cash');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Sales Report: change a walk-in cash bill to credit for a customer — due, books and health check follow', { skip }, async()=>{
  const fx = JSON.parse(JSON.stringify(fixture));
  fx.collections.invoices.push({ id:'inv2', billNo:'B2', customerId:null, customerName:'NC', payment:'cash', totalToPay:300, paidAmount:300, paid:true,
    createdAtMs:2, accountingStatus:'POSTED', items:[{ itemId:'it1', brandName:'Testamol', qty:3, lineTotal:300, costTotal:180 }] });
  fx.collections.glJournals.push({ id:'js2', journalNo:'JE-3', date:'2026-10-03', status:'POSTED', sourceType:'SALE', sourceId:'inv2', description:'Bill B2',
    lines:[L('1000',300,0), L('4000',0,300), L('5000',180,0), L('1210',0,180)] });
  fx.collections.batches[0].remainingUnits = 17;                                         // 3 sold on B2
  const saved = fixture.collections; fixture.collections = fx.collections;
  const { browser, page, errors } = await signIn();
  fixture.collections = saved;
  try{
    await page.getByText('Reports', { exact:true }).first().click();
    await page.getByRole('button', { name:'🧾 Sales Report' }).click();
    await page.locator('input[type=date]').first().fill('1970-01-01');
    const row = page.locator('tr', { hasText:'B2' });
    await row.getByTitle('Change to credit bill (Admin PIN required)').click();
    await page.getByTestId('credit-fix').locator('input').fill('Alpha');
    await page.getByTestId('credit-fix').getByText('Alpha Test').click();
    await page.waitForFunction(()=> (window.firebase.__store.glJournals||[]).some(j=> j.sourceType==='BILL_TO_CREDIT' && j.status==='POSTED'));
    const inv = await page.evaluate(()=> window.firebase.__store.invoices.find(i=> i.id==='inv2'));
    assert.deepEqual([inv.payment, inv.paidAmount, inv.paid, inv.customerId, inv.changedFromPayment], ['credit', 0, false, 'c1', 'cash']);
    assert.equal(await page.evaluate(()=> window.firebase.__store.customers.find(c=> c.id==='c1').dueAmount), 1300);
    const j = await page.evaluate(()=> window.firebase.__store.glJournals.find(j=> j.sourceType==='BILL_TO_CREDIT'));
    assert.deepEqual(j.lines.map(l=>[l.accountId, l.debit, l.credit]), [['a1100',300,0],['a1000',0,300]]);
    await page.getByText('Finance (Setup)', { exact:true }).first().click();
    const t = await page.getByTestId('health-control').innerText();
    assert.match(t, /1100[^\n]*Rs\. 1300\.00\s+Rs\. 1300\.00/);
    assert.equal((t.match(/✓ matches/g)||[]).length, 3, t);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Suppliers: old unpaid bill with no stock → supplier due and books, stock untouched', { skip }, async()=>{
  const fx = JSON.parse(JSON.stringify(fixture));
  fx.collections.suppliers = [{ id:'s1', name:'Supp', credit:30 }];
  fx.collections.glAccounts.push({ id:'a4100', accountCode:'4100', accountName:'Other Income', accountType:'REVENUE', isActive:true },
    { id:'a6600', accountCode:'6600', accountName:'Other Expenses', accountType:'EXPENSE', isActive:true });
  const saved = fixture.collections; fixture.collections = fx.collections;
  const { browser, page, errors } = await signIn();
  fixture.collections = saved;
  try{
    await page.getByText('Suppliers', { exact:true }).first().click();
    const card = page.getByTestId('old-supplier-bill');
    await card.locator('select').selectOption('s1');
    await card.locator('input[type=number]').fill('500');
    await card.getByRole('button', { name:'💾 Save Old Bill' }).click();
    await page.waitForFunction(()=> (window.firebase.__store.glJournals||[]).some(j=> j.sourceType==='GRN' && j.description.includes('OLD-')));
    const g = await page.evaluate(()=> window.firebase.__store.grns.find(g=> g.isOpeningBalance));
    assert.deepEqual([g.payment, g.paid, g.totalAmount], ['credit', false, 500]);
    const j = await page.evaluate((id)=> window.firebase.__store.glJournals.find(j=> j.sourceId===id), g.id);
    assert.deepEqual(j.lines.map(l=>[l.accountId, l.debit, l.credit]), [['a3000',500,0],['a2100',0,500]]);
    assert.equal(await page.evaluate(()=> window.firebase.__store.batches.length), 1);               // no stock added

    // settle it with goods from another GRN; the supplier credits Rs 500 for stock that cost Rs 300
    await page.getByText('Returns', { exact:true }).first().click();
    await page.getByRole('button', { name:'📦 GRN Return' }).click();
    await page.getByPlaceholder('GRN No').fill(g.grnNo);
    await page.getByRole('button', { name:'🔍 Find GRN' }).click();
    await page.getByTestId('grn-return-other').fill('Testa');
    await page.locator('.ac-item', { hasText:'Testamol' }).first().dispatchEvent('mousedown');
    await page.locator('tr', { hasText:'Testamol' }).locator('input[type=number]').fill('5');
    await page.getByTestId('grn-credit-value').fill('500');
    await page.getByRole('button', { name:'↩️ Process GRN Return' }).click();
    await page.waitForFunction(()=> (window.firebase.__store.glJournals||[]).some(j=> j.sourceType==='GRN_RETURN' && j.status==='POSTED'));
    const g2 = await page.evaluate((id)=> window.firebase.__store.grns.find(x=> x.id===id), g.id);
    assert.deepEqual([g2.totalAmount, g2.paid], [0, true]);                                              // bill settled
    const rj = await page.evaluate(()=> window.firebase.__store.glJournals.find(j=> j.sourceType==='GRN_RETURN'));
    assert.deepEqual(rj.lines.map(l=>[l.accountId, l.debit, l.credit]), [['a2100',500,0],['a1210',0,300],['a4100',0,200]]);
    assert.equal(await page.evaluate(()=> window.firebase.__store.batches.find(b=> b.id==='b1').remainingUnits), 15);
    await page.getByText('Finance (Setup)', { exact:true }).first().click();
    const t = await page.getByTestId('health-control').innerText();
    assert.equal((t.match(/✓ matches/g)||[]).length, 3, t);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Sales Report search finds a bill from any date by its number', { skip }, async()=>{
  const { browser, page, errors } = await signIn();
  try{
    await page.getByText('Reports', { exact:true }).first().click();
    await page.getByRole('button', { name:'🧾 Sales Report' }).click();
    assert.ok(!(await page.locator('tbody').innerText()).includes('B1'));          // 1970 bill is outside today's range
    await page.getByTestId('bill-search').fill('b1');
    await page.locator('tr', { hasText:'Alpha Test' }).first().waitFor();
    assert.match(await page.locator('body').innerText(), /bills 1ක් හම්බුණා/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Sub GRN: items received by unit qty with unit cost/sales → stock, supplier due and books', { skip }, async()=>{
  const fx = JSON.parse(JSON.stringify(fixture));
  fx.collections.suppliers = [{ id:'s1', name:'Supp' }];
  fx.collections.items = [{ id:'it1', itemNumber:'T001', brandName:'Testamol', genericName:'Paracetamol', unit:'tab', packSize:10 }];
  const saved = fixture.collections; fixture.collections = fx.collections;
  const { browser, page, errors } = await signIn();
  fixture.collections = saved;
  try{
    await page.getByText('Sub GRN Entry', { exact:true }).first().click();
    await page.getByText('🧩 Sub GRN Entry (units)').waitFor();
    for(const l of ['Pack Size','Pkt Qty (full packs)','Free Qty (packs)','Pkt Cost (Rs.)','Pkt Sales (Rs.)'])
      assert.equal(await page.getByText(l, { exact:true }).count(), 0, l);
    await page.locator('select').first().selectOption('s1');
    await page.getByPlaceholder('type code or brand name...').fill('Testa');
    await page.locator('.ac-item', { hasText:'Testamol' }).first().dispatchEvent('mousedown');
    await page.getByTestId('sub-grn-qty').fill('25');
    await page.getByTestId('sub-grn-unit-cost').fill('4');
    await page.getByTestId('sub-grn-unit-sales').fill('6');
    await page.locator('input[type=date]').nth(1).fill('2027-08-01');
    await page.getByRole('button', { name:'+ Add' }).click();
    await page.locator('select').nth(2).selectOption('credit');
    await page.getByRole('button', { name:'💾 Save GRN & Update Stock' }).click();
    await page.waitForFunction(()=> (window.firebase.__store.glJournals||[]).filter(j=> j.sourceType==='GRN' && j.status==='POSTED').length===2);
    const g = await page.evaluate(()=> window.firebase.__store.grns.find(g=> g.grnType==='sub'));
    assert.deepEqual([g.payment, g.paid, g.totalAmount], ['credit', false, 100]);
    const b = await page.evaluate((id)=> window.firebase.__store.batches.find(b=> b.grnId===id), g.id);
    assert.deepEqual([b.remainingUnits, b.unitCost, b.unitSell, b.qtyPacks, b.looseQty, b.expiryDate], [25, 4, 6, 2, 5, '2027-08-01']);
    const j = await page.evaluate((id)=> window.firebase.__store.glJournals.find(j=> j.sourceId===id), g.id);
    assert.deepEqual(j.lines.map(l=>[l.accountId, l.debit, l.credit]), [['a1210',100,0],['a2100',0,100]]);
    await page.getByText('Finance (Setup)', { exact:true }).first().click();
    const t = await page.getByTestId('health-control').innerText();
    assert.equal((t.match(/✓ matches/g)||[]).length, 3, t);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

const field = (page, label)=> page.locator('xpath=//label[normalize-space(.)="' + label + '"]/following-sibling::input');
test('GRN: last prices show when an item is typed; selling price at or below cost shows a warning', { skip }, async()=>{
  const fx = JSON.parse(JSON.stringify(fixture));
  fx.collections.suppliers = [{ id:'s1', name:'Supp' }];
  fx.collections.items = [{ id:'it1', itemNumber:'T001', brandName:'Testamol', genericName:'Paracetamol', unit:'tab', packSize:10 }];
  const saved = fixture.collections; fixture.collections = fx.collections;
  const { browser, page, errors } = await signIn();
  fixture.collections = saved;
  try{
    await page.getByText('GRN Entry', { exact:true }).first().click();
    await page.getByPlaceholder('type code or brand name...').fill('Testa');
    assert.match(await page.locator('.ac-item', { hasText:'Testamol' }).first().innerText(), /cost 60\.00 · sell 100\.00/);
    await page.locator('.ac-item', { hasText:'Testamol' }).first().dispatchEvent('mousedown');
    assert.match(await page.getByTestId('last-price-note').innerText(), /Unit Cost Rs 60\.00 · Unit Sell Rs 100\.00/);
    await field(page,'Pkt Cost (Rs.)').fill('120');
    await field(page,'Pkt Sales (Rs.)').fill('150');
    assert.equal(await page.getByTestId('grn-price-warning').count(), 0);
    await field(page,'Pkt Sales (Rs.)').fill('120');
    assert.match(await page.getByTestId('grn-price-warning').innerText(), /සමානයි/);
    await field(page,'Pkt Sales (Rs.)').fill('100');
    assert.match(await page.getByTestId('grn-price-warning').innerText(), /අඩුයි/);

    await page.getByText('Stock', { exact:true }).first().click();
    await page.getByTestId('stock-search').fill('testa');
    const row = await page.locator('tr', { hasText:'Testamol' }).innerText();
    assert.match(row, /60\.00\s+100\.00/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Reports → Charts: tiles, trend chart with hover, top items, payment mix', { skip }, async()=>{
  const fx = JSON.parse(JSON.stringify(fixture));
  fx.collections.invoices[0].createdAtMs = Date.now();
  const saved = fixture.collections; fixture.collections = fx.collections;
  const { browser, page, errors } = await signIn();
  fixture.collections = saved;
  try{
    await page.setViewportSize({ width:1200, height:1400 });
    await page.getByText('Reports', { exact:true }).first().click();
    await page.getByRole('button', { name:'📊 Charts' }).click();
    await page.getByRole('button', { name:'දින 30' }).click();
    const charts = page.getByTestId('charts');
    const text = await charts.innerText();
    assert.match(text, /Rs\. 1,000\.00/);            // sales
    assert.match(text, /40\.0% margin/);             // (1000-600)/1000
    assert.match(text, /Testamol/);
    assert.match(text, /Credit/);
    await charts.locator('svg rect[fill="transparent"]').last().hover();
    assert.match(await charts.innerText(), /Gross profit: Rs\. 400\.00/);
    if(process.env.SHOT) await charts.screenshot({ path: process.env.SHOT });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Charts → item analysis: price history, busiest months, best brand of a generic', { skip }, async()=>{
  const fx = JSON.parse(JSON.stringify(fixture));
  fx.collections.items = [{ id:'it1', itemNumber:'T001', brandName:'Testamol', genericName:'Paracetamol', unit:'tab', packSize:10 },
    { id:'it2', itemNumber:'P002', brandName:'Panadol', genericName:'Paracetamol', unit:'tab', packSize:10 }];
  fx.collections.batches.push({ id:'b2', itemId:'it1', brandName:'Testamol', remainingUnits:5, unitCost:70, unitSell:110, expiryDate:'2027-09-01', openingDate:'2026-10-10', isOpeningStock:true });
  fx.collections.invoices[0].createdAtMs = Date.now();
  fx.collections.invoices.push({ id:'inv2', billNo:'B2', customerName:'Walk-in', payment:'cash', totalToPay:300, paidAmount:300, paid:true, createdAtMs:Date.now(),
    items:[{ itemId:'it2', brandName:'Panadol', qty:3, unitPrice:100, lineTotal:300, costTotal:270, unitCost:90 }] });
  const saved = fixture.collections; fixture.collections = fx.collections;
  const { browser, page, errors } = await signIn();
  fixture.collections = saved;
  try{
    await page.setViewportSize({ width:1200, height:1400 });
    await page.getByText('Reports', { exact:true }).first().click();
    await page.getByRole('button', { name:'📊 Charts' }).click();
    await page.getByRole('button', { name:'දින 30' }).click();
    const box = page.getByTestId('item-analysis');
    await page.getByTestId('analysis-item').fill('testa');
    await box.locator('.ac-item', { hasText:'Testamol' }).dispatchEvent('mousedown');
    const t = await box.innerText();
    assert.match(t, /cost 16\.7%, sell 10\.0% වෙනස් වෙලා/);       // 60→70, 100→110
    assert.match(t, /වැඩිම: \S+ \d\d \(10\)/);
    await page.getByTestId('analysis-generic').fill('Paracetamol');
    const t2 = await box.innerText();
    assert.match(t2, /වැඩියෙන්ම profit: Testamol — Rs\. 400\.00/);
    assert.match(t2, /Panadol/);
    if(process.env.SHOT) await box.screenshot({ path: process.env.SHOT });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
