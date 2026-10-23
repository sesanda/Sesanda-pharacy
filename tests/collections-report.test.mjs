// Unit tests for the Reports → "To Collect" helper. SYNTHETIC fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers } from './_extract.mjs';
const { buildCollectionsReport } = loadHelpers(['invoiceBalanceInfo','computeCustomerOutstanding','reconcileToMs','reconcileDay','buildCollectionsReport']);

const NOW = Date.UTC(2026, 9, 23);
const daysAgo = d => NOW - d*86400000;

test('totals, aging buckets and per-customer rows come from unpaid bills', ()=>{
  const customers = [
    { id:'c1', name:'Alpha Test', tel:'0770000001', dueAmount:999 },   // stored value is ignored here
    { id:'c2', name:'Beta Test',  tel:'0770000002' },
    { id:'c3', name:'Gamma Test', tel:'0770000003' },                 // owes nothing
  ];
  const invoices = [
    { id:'i1', customerId:'c1', payment:'credit', totalToPay:1000, paidAmount:400, createdAtMs:daysAgo(10) },   // 600, 0–30
    { id:'i2', customerId:'c1', payment:'cash',   totalToPay:500,  paidAmount:200, createdAtMs:daysAgo(45) },   // 300, 31–60
    { id:'i3', customerId:'c2', payment:'credit', totalToPay:2000, paidAmount:0,   createdAtMs:daysAgo(120) },  // 2000, 90+
    { id:'i4', customerId:'c3', payment:'credit', totalToPay:700,  paidAmount:700, paid:true, createdAtMs:daysAgo(5) },
    { id:'i5', customerId:'gone', payment:'credit', totalToPay:250, paidAmount:0, createdAtMs:daysAgo(3) },     // unlinked
  ];
  const payments = [{ customerId:'c1', amount:400, createdAt:{ toMillis:()=>daysAgo(8) } }];
  const r = buildCollectionsReport(customers, invoices, payments, NOW);
  assert.equal(r.total, 2900);
  assert.equal(r.customersOwing, 2);
  assert.equal(r.openBills, 3);
  assert.deepEqual(r.buckets.map(b=>[b.label, b.bills, b.amount]),
    [['0–30 days',1,600], ['31–60 days',1,300], ['61–90 days',0,0], ['Over 90 days',1,2000]]);
  assert.deepEqual(r.rows.map(x=>[x.id, x.outstanding, x.openBills, x.oldestDays]), [['c2',2000,1,120], ['c1',900,2,45]]);
  assert.equal(r.rows[1].lastPayment, '2026-10-15');
  assert.equal(r.unlinkedBills, 1); assert.equal(r.unlinkedAmount, 250);
});

test('no unpaid bills → empty report', ()=>{
  const r = buildCollectionsReport([{ id:'c1', name:'A' }], [], [], NOW);
  assert.equal(r.total, 0); assert.equal(r.rows.length, 0);
  assert.ok(r.buckets.every(b=> b.amount===0 && b.bills===0));
});
