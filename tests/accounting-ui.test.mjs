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
    accountingStatus:'POSTED', createdAtMs:1, items:[{ itemId:'it1', brandName:'Testamol', qty:10, lineTotal:1000, costTotal:600, unitCost:60 }] }],
  grns: [{ id:'g1', grnNo:'GRN-1', supplierId:'s1', supplierName:'Supp', payment:'credit', paid:false, totalAmount:1800, paidAmount:0, accountingStatus:'POSTED', date:'2026-10-01' }],
  batches: [{ id:'b1', itemId:'it1', brandName:'Testamol', remainingUnits:20, unitCost:60, grnId:'g1', batchCode:'B-1' }],
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
