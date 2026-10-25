// Browser regression test: loads the REAL index.html in headless Chromium with Firebase replaced by
// tests/firebase-stub.js and SYNTHETIC fixtures. Needs playwright-core + react UMD + @babel/standalone
// resolvable via TEST_DEPS (a node_modules dir). Run:  TEST_DEPS=/path/to/node_modules node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// Sidebar pages sit inside folding groups: open the page's group first if it's closed.
async function goTo(page, label){
  const btn = page.locator('.side .nav-btn').filter({ has: page.getByText(label, { exact:true }) }).first();
  if(!(await btn.isVisible().catch(()=>false))) await page.locator('.side .nav-group[data-labels*="|' + label + '|"]').first().click();
  await btn.click();
}
const here = path.dirname(fileURLToPath(import.meta.url));
const DEPS = process.env.TEST_DEPS;
const HTML_FILE = process.env.TEST_HTML || path.join(here, '..', 'index.html');
const skip = !DEPS && 'TEST_DEPS not set — browser tests skipped';
const req = DEPS ? createRequire(path.join(DEPS, 'x.js')) : null;

const customers = [
  { id:'c1', name:'Alpha Test', tel:'0770000001', code:'T1', category:'NC', dueAmount:1500 },
  { id:'c2', name:'Beta Test',  tel:'0770000002', code:'T2', category:'VIP', dueAmount:0 },
  { id:'c3', name:'Gamma Test', tel:'0770000003', code:'',  category:'NC', dueAmount:999 },   // stored ≠ bills
  { id:'c4', tel:'0770000004', category:'NC' },                                                // missing name
];
const invoices = [
  { id:'i1', billNo:'INV-T1', customerId:'c1', payment:'credit', totalToPay:1000, paidAmount:500, paid:false, createdAtMs:1 },
  { id:'i2', billNo:'INV-T2', customerId:'c1', payment:'cash',   totalToPay:2000, paidAmount:1000, paid:false, createdAtMs:2 },
  { id:'i3', billNo:'INV-T3', customerId:'c2', payment:'credit', totalToPay:800,  paidAmount:800, paid:true, createdAtMs:3 },
  { id:'i4', billNo:'INV-T4', customerId:'c3', payment:'credit', totalToPay:400,  paidAmount:0,   paid:false, createdAtMs:4 },
];

async function openCustomers({ failCollections=[], htmlFile=HTML_FILE }={}){
  const { chromium } = req('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args:['--no-sandbox'] });
  try {
  const page = await browser.newPage(); page.setDefaultTimeout(15000);
  if(process.env.TEST_DEBUG) page.on('console', m=> console.log('[page]', m.type(), m.text().slice(0,200)));
  const errors = []; page.on('pageerror', e=> errors.push(String(e)));
  const fixture = { collections:{ customers, invoices, items:[], batches:[], payments:[], glAccounts:[], glJournals:[] }, failCollections };
  const stub = fs.readFileSync(path.join(here,'firebase-stub.js'),'utf8');
  const local = {
    'react.production.min.js': path.join(DEPS,'react/umd/react.production.min.js'),
    'react-dom.production.min.js': path.join(DEPS,'react-dom/umd/react-dom.production.min.js'),
    'babel.min.js': path.join(DEPS,'@babel/standalone/babel.min.js'),
  };
  await page.route('**/*', async route=>{
    const url = route.request().url();
    if(url==='http://app.test/') return route.fulfill({ contentType:'text/html', body: fs.readFileSync(htmlFile,'utf8') });
    if(url.includes('firebase-app-compat')) return route.fulfill({ contentType:'text/javascript', body: 'window.__FIXTURE__='+JSON.stringify(fixture)+';\n'+stub });
    for(const k of Object.keys(local)) if(url.endsWith(k)) return route.fulfill({ contentType:'text/javascript', body: fs.readFileSync(local[k],'utf8') });
    if(/\.js(\?|$)/.test(url) || url.includes('/js')) return route.fulfill({ contentType:'text/javascript', body:'' });
    return route.fulfill({ status:204, body:'' });
  });
  await page.goto('http://app.test/', { waitUntil:'commit' });
  await page.getByText('Staff / Admin Portal').waitFor({ timeout:60000 });
  await page.getByText('Staff / Admin Portal').click();
  await page.locator('input[type=email], input').first().waitFor();
  const inputs = page.locator('input');
  await inputs.nth(0).fill('tester@example.test'); await inputs.nth(1).fill('x');
  await page.getByRole('button', { name:'Login' }).click();
  await goTo(page, 'Customers');
  await page.waitForTimeout(600);
  return { browser, page, errors };
  } catch(e){ await browser.close(); throw e; }
}

test('customers list loads after sign-in (regression: listener died on login screen)', { skip }, async()=>{
  const { browser, page, errors } = await openCustomers();
  try{
    const text = await page.locator('body').innerText();
    for(const n of ['Alpha Test','Beta Test','Gamma Test','(no name)']) assert.ok(text.includes(n), 'missing '+n);
    assert.ok(text.includes('0770000002'));
    assert.ok(!text.includes('Customers නැහැ'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('outstanding per customer and total come from bills, mismatch flagged, nothing written', { skip }, async()=>{
  const { browser, page } = await openCustomers();
  try{
    const text = await page.locator('body').innerText();
    // c1: 500 (credit partial) + 1000 (cash partial) = 1500 ; c2: 0 ; c3: 400 (stored 999) ; total 1900
    assert.match(text, /Total Due: Rs\. 1,900\.00/);
    assert.match(text, /Total Due: Rs\. 1,500\.00\s*\(2 open bills\)/);
    assert.match(text, /Stored due Rs\. 999\.00 ≠ bills Rs\. 400\.00/);
    assert.match(text, /1 stored due value\(s\) differ/);
    assert.deepEqual(await page.evaluate(()=>window.__writes), []);
  } finally { await browser.close(); }
});

test('search filters by name / tel / code and "debtors only" keeps valid debtors', { skip }, async()=>{
  const { browser, page } = await openCustomers();
  try{
    const search = page.getByTestId('customer-search');
    await search.fill('beta'); let t = await page.locator('body').innerText();
    assert.ok(t.includes('Beta Test') && !t.includes('Alpha Test'));
    await search.fill('0770000003'); t = await page.locator('body').innerText();
    assert.ok(t.includes('Gamma Test') && !t.includes('Beta Test'));
    await search.fill('T1'); t = await page.locator('body').innerText();
    assert.ok(t.includes('Alpha Test'));
    await search.fill('nobody-matches'); t = await page.locator('body').innerText();
    assert.ok(t.includes('Search එකට ගැලපෙන customers නැහැ'));
    await search.fill('');
    await page.getByText('Show only customers with due amount').click(); t = await page.locator('body').innerText();
    assert.ok(t.includes('Alpha Test') && t.includes('Gamma Test') && !t.includes('Beta Test'));
  } finally { await browser.close(); }
});

test('"Download balance check" button downloads the reconciliation CSV without writing', { skip }, async()=>{
  const { browser, page } = await openCustomers();
  try{
    const [dl] = await Promise.all([ page.waitForEvent('download'), page.getByTestId('balance-check').click() ]);
    assert.match(dl.suggestedFilename(), /^reconcile-customer-balances-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    assert.match(csv, /c3,Gamma Test,0770000003,,999,400,599,1/);   // stored 999 vs bills 400
    assert.ok(!/\nc1,/.test(csv));                                  // c1 matches its bills
    assert.deepEqual(await page.evaluate(()=>window.__writes), []);
  } finally { await browser.close(); }
});

test('Reports → "To Collect" shows money owed by customers, read-only', { skip }, async()=>{
  const { browser, page } = await openCustomers();
  try{
    await goTo(page, 'Reports');
    await page.getByRole('button', { name:'💰 To Collect' }).click();
    const report = page.getByTestId('collect-report');
    await report.waitFor();
    const t = await report.innerText();
    assert.equal(await page.getByTestId('collect-total').innerText(), 'Rs. 1,900.00');   // c1 1,500 + c3 400
    assert.ok(t.includes('Alpha Test') && t.includes('Gamma Test') && !t.includes('Beta Test'));
    assert.ok(t.indexOf('Alpha Test') < t.indexOf('Gamma Test'));                        // largest first
    const [dl] = await Promise.all([ page.waitForEvent('download'), page.getByTestId('report-balance-check').click() ]);
    assert.match(dl.suggestedFilename(), /^reconcile-customer-balances-/);
    assert.deepEqual(await page.evaluate(()=>window.__writes), []);
  } finally { await browser.close(); }
});

test('Firestore error is shown instead of an empty list', { skip }, async()=>{
  const { browser, page } = await openCustomers({ failCollections:['customers'] });
  try{
    const t = await page.locator('body').innerText();
    assert.ok(t.includes('Customers load වුනේ නැහැ: unavailable'));
  } finally { await browser.close(); }
});
