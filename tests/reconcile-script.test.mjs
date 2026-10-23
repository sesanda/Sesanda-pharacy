// Tests for scripts/reconcile-customer-balances.js. SYNTHETIC fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { extractFunction } from './_extract.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, '..', 'scripts', 'reconcile-customer-balances.js');
const { buildReconcileReport: buildReport, reconcileReportCsv: toCsv } = createRequire(import.meta.url)(scriptPath);

test('script helpers are identical to index.html', ()=>{
  const script = fs.readFileSync(scriptPath, 'utf8');
  for(const name of ['invoiceBalanceInfo','computeCustomerOutstanding','reconcileToMs','reconcileDay','buildReconcileReport','reconcileReportCsv']){
    assert.ok(script.includes(extractFunction(name)), name + ' in the script differs from index.html');
  }
});

test('report lists mismatches (largest first), unlinked bills and last payment', ()=>{
  const customers = [
    { id:'c1', name:'Alpha Test', tel:'0770000001', dueAmount:1500 },   // matches bills
    { id:'c2', name:'Beta Test',  tel:'0770000002', dueAmount:999 },    // bills say 400
    { id:'c3', name:'Gamma Test', tel:'0770000003', dueAmount:0 },      // bills say 50
  ];
  const invoices = [
    { id:'i1', customerId:'c1', payment:'credit', totalToPay:1000, paidAmount:500 },
    { id:'i2', customerId:'c1', payment:'cash', totalToPay:2000, paidAmount:1000 },
    { id:'i3', customerId:'c2', payment:'credit', totalToPay:400, paidAmount:0 },
    { id:'i4', customerId:'c3', payment:'credit', totalToPay:50, paidAmount:0 },
    { id:'i5', customerId:'gone', billNo:'INV-9', payment:'credit', totalToPay:300, paidAmount:0, createdAtMs:Date.UTC(2026,9,1) },
  ];
  const payments = [
    { customerId:'c2', amount:100, createdAt:{ toMillis:()=>Date.UTC(2026,8,1) } },
    { customerId:'c2', amount:250, createdAt:{ toMillis:()=>Date.UTC(2026,9,5) } },
  ];
  const r = buildReport(customers, invoices, payments);
  assert.deepEqual(r.summary, { customers:3, invoices:5, totalFromBills:1950, totalStored:2499,
    totalDifference:549, mismatchedCustomers:2, unlinkedUnpaidBills:1 });
  assert.deepEqual(r.mismatches.map(m=>[m.customerId, m.difference]), [['c2',599],['c3',-50]]);
  assert.equal(r.mismatches[0].lastPayment, '2026-10-05');
  assert.equal(r.mismatches[0].lastPaymentAmount, 250);
  assert.deepEqual(r.unlinked.map(u=>[u.billNo, u.balance, u.date]), [['INV-9', 300, '2026-10-01']]);
  const csv = toCsv(r);
  assert.match(csv, /^Summary\n/);
  assert.match(csv, /c2,Beta Test,0770000002,,999,400,599,1,2026-10-05,250/);
});

test('no mismatches → empty sections, CSV says (none)', ()=>{
  const r = buildReport([{ id:'c1', name:'A, "quoted"', dueAmount:0 }], [], []);
  assert.equal(r.mismatches.length, 0);
  assert.equal((toCsv(r).match(/\(none\)/g)||[]).length, 2);
});
