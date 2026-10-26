// Regression smoke: signs in (stubbed Firebase, synthetic data) and opens every Staff tab,
// failing on any uncaught page error. Same TEST_DEPS requirement as customers-ui.test.mjs.
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
test('every staff tab renders without uncaught errors', { skip: !DEPS && 'TEST_DEPS not set' }, async()=>{
  const req = createRequire(path.join(DEPS, 'x.js'));
  const { chromium } = req('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args:['--no-sandbox'] });
  try{
    const page = await browser.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e=> errors.push(String(e)));
    const fixture = { collections:{
      customers:[{id:'c1', name:'Alpha Test', tel:'0770000001', dueAmount:500, category:'VIP'}],
      invoices:[{id:'i1', billNo:'INV-T1', customerId:'c1', customerName:'Alpha Test', payment:'credit', totalToPay:500, paidAmount:0, paid:false, createdAtMs:Date.now(), items:[]}],
    }};
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
    await page.locator('.side .brand').waitFor();
    const labels = ['Dashboard','New Bill','Item Registration','Purchase Orders','GRN Entry','Returns','Opening Stock','Stock','Suppliers','Customers','Orders','Prescriptions/Voice','Reports','Cash Control','Finance (Setup)','General Ledger','Trial Balance','Profit & Loss','Balance Sheet','Accounts Receivable','Accounts Payable','Cash Flow Statement','Expenses','Capital & Loans','AI Insights','Bank Accounts','Sub GRN Entry','Dashboard'];
    // groups start folded; a heading opens and closes its pages
    const gl = page.locator('.side .nav-btn').filter({ has: page.getByText('General Ledger', { exact:true }) });
    assert.equal(await gl.count(), 0);
    await page.locator('.side .nav-group', { hasText:'Accounting' }).click();
    await gl.waitFor();
    if(process.env.SHOT) await page.locator('.side').screenshot({ path: process.env.SHOT });
    await page.locator('.side .nav-group', { hasText:'Accounting' }).click();
    assert.equal(await gl.count(), 0);
    const visited = [];
    for(const label of [...new Set(labels)]){
      if(/Sign out|Back/.test(label)) continue;
      try{ await goTo(page, label); }catch(e){ continue; }
      await page.waitForTimeout(250); visited.push(label);
    }
    console.log('visited tabs:', visited.join(', '));
    assert.ok(visited.length>10, 'expected to visit most tabs, got '+visited.length);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
