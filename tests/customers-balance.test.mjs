// Run: node --test tests/
// All records below are SYNTHETIC test fixtures — never production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers } from './_extract.mjs';
const { invoiceBalanceInfo, computeCustomerOutstanding, customerMatchesQuery, applySalesReturnToInvoice } =
  (()=>{ globalThis.todayISO = ()=>'2026-10-20'; return loadHelpers(['invoiceBalanceInfo','computeCustomerOutstanding','customerMatchesQuery','applySalesReturnToInvoice']); })();

const cust = (id, extra={}) => ({ id, name:'Test '+id, tel:'07700000'+id.slice(-2), dueAmount:0, ...extra });
const inv = (id, customerId, extra={}) => ({ id, customerId, billNo:'INV-'+id, payment:'credit', totalToPay:1000, paidAmount:0, paid:false, createdAtMs:1, ...extra });

test('customer with zero outstanding', ()=>{
  const r = computeCustomerOutstanding([cust('c01')], [inv('i1','c01',{payment:'cash', paidAmount:1000, paid:true})]);
  assert.equal(r.byId.c01.outstanding, 0); assert.equal(r.total, 0); assert.equal(r.byId.c01.mismatch, false);
});

test('credit sale with partial payment', ()=>{
  const r = computeCustomerOutstanding([cust('c01',{dueAmount:600})], [inv('i1','c01',{paidAmount:400})]);
  assert.equal(r.byId.c01.outstanding, 600); assert.equal(r.byId.c01.openBills, 1); assert.equal(r.byId.c01.mismatch, false);
});

test('fully paid credit invoice contributes nothing', ()=>{
  const r = computeCustomerOutstanding([cust('c01')], [inv('i1','c01',{paidAmount:1000, paid:true, settledPaymentMethod:'cash'})]);
  assert.equal(r.byId.c01.outstanding, 0); assert.equal(r.byId.c01.openBills, 0);
});

test('legacy credit invoice flagged paid without paidAmount is treated as paid', ()=>{
  const i = inv('i1','c01'); delete i.paidAmount; i.paid = true;
  assert.equal(invoiceBalanceInfo(i).balance, 0);
});

test('multiple invoices and payments for one customer', ()=>{
  const invoices = [
    inv('i1','c01',{totalToPay:1000, paidAmount:1000, paid:true}),
    inv('i2','c01',{totalToPay:2500, paidAmount:500}),
    inv('i3','c01',{totalToPay:750, paidAmount:0}),
    inv('i4','c02',{totalToPay:300}),
  ];
  const r = computeCustomerOutstanding([cust('c01',{dueAmount:2750}), cust('c02',{dueAmount:300})], invoices);
  assert.equal(r.byId.c01.outstanding, 2750); assert.equal(r.byId.c01.openBills, 2);
  assert.equal(r.byId.c02.outstanding, 300);
  assert.equal(r.total, 3050); assert.equal(r.mismatchCount, 0);
});

test('partly paid CASH bill is outstanding and not reported PAID', ()=>{
  const i = inv('i1','c01',{payment:'cash', totalToPay:1500, paidAmount:1000, paid:false});
  const info = invoiceBalanceInfo(i);
  assert.equal(info.balance, 500); assert.equal(info.isPaid, false);
  assert.equal(computeCustomerOutstanding([cust('c01',{dueAmount:500})],[i]).byId.c01.outstanding, 500);
});

test('legacy cash bill without paidAmount is fully paid', ()=>{
  const i = { id:'i1', customerId:'c01', payment:'cash', totalToPay:900 };
  assert.deepEqual(invoiceBalanceInfo(i), {total:900, paidAmt:900, balance:0, isPaid:true});
});

test('sales return on a credit bill reduces outstanding (existing return rule)', ()=>{
  const before = inv('i1','c01',{totalToPay:1000, paidAmount:200});
  const { update, dueReduction } = applySalesReturnToInvoice(before, 300);
  const after = { ...before, ...update };
  assert.equal(dueReduction, 300);
  const r = computeCustomerOutstanding([cust('c01',{dueAmount:500})],[after]);
  assert.equal(r.byId.c01.outstanding, 500); assert.equal(r.byId.c01.mismatch, false);
});

test('return that clears the balance settles the bill', ()=>{
  const before = inv('i1','c01',{totalToPay:1000, paidAmount:700});
  const after = { ...before, ...applySalesReturnToInvoice(before, 300).update };
  assert.equal(after.paid, true);
  assert.equal(computeCustomerOutstanding([cust('c01')],[after]).byId.c01.outstanding, 0);
});

test('deleted (voided) invoice — removed doc — no longer counts', ()=>{
  const all = [inv('i1','c01'), inv('i2','c01')];
  const afterDelete = all.filter(i=>i.id!=='i2');
  assert.equal(computeCustomerOutstanding([cust('c01')], afterDelete).byId.c01.outstanding, 1000);
});

test('duplicate invoice entries are not double counted', ()=>{
  const i = inv('i1','c01');
  const r = computeCustomerOutstanding([cust('c01',{dueAmount:1000})], [i, {...i}, i]);
  assert.equal(r.byId.c01.outstanding, 1000); assert.equal(r.total, 1000);
});

test('stored dueAmount that disagrees with bills is flagged, never altered', ()=>{
  const c = cust('c01',{dueAmount:1800});
  const r = computeCustomerOutstanding([c], [inv('i1','c01')]);
  assert.equal(r.byId.c01.mismatch, true); assert.equal(r.byId.c01.storedDue, 1800);
  assert.equal(c.dueAmount, 1800); assert.equal(r.storedTotal, 1800); assert.equal(r.total, 1000);
});

test('string-typed stored amounts do not concatenate', ()=>{
  const r = computeCustomerOutstanding([cust('c01',{dueAmount:'500'}), cust('c02',{dueAmount:'250.5'})], []);
  assert.equal(r.storedTotal, 750.5);
});

test('unpaid bill with unknown / missing customerId is reported as unlinked, not given to someone else', ()=>{
  const r = computeCustomerOutstanding([cust('c01')], [inv('i1','zzz'), inv('i2',null)]);
  assert.equal(r.byId.c01.outstanding, 0); assert.equal(r.unlinked.length, 2);
});

test('no customer is matched by phone number to someone else\'s bill', ()=>{
  const r = computeCustomerOutstanding([cust('c01',{tel:'0771234567'}), cust('c02',{tel:'0771234567'})], [inv('i1','c02')]);
  assert.equal(r.byId.c01.outstanding, 0); assert.equal(r.byId.c02.outstanding, 1000);
});

test('customer search: name / tel / code, case-insensitive, null-safe', ()=>{
  const list = [
    {id:'a', name:'Nimal Perera', tel:'077 123 4567', code:'VIP01'},
    {id:'b', name:'Kamala', tel:'0711111111'},
    {id:'c', tel:'0722222222'},           // missing name
    {id:'d', name:'Sunil'},               // missing tel
  ];
  const f = q => list.filter(c=>customerMatchesQuery(c,q)).map(c=>c.id);
  assert.deepEqual(f(''), ['a','b','c','d']);
  assert.deepEqual(f('nimal'), ['a']);
  assert.deepEqual(f('PERERA'), ['a']);
  assert.deepEqual(f('vip01'), ['a']);
  assert.deepEqual(f('0771234567'), ['a']);     // digits match despite spaces in stored tel
  assert.deepEqual(f('0722'), ['c']);
  assert.deepEqual(f('sun'), ['d']);
  assert.deepEqual(f('  '), ['a','b','c','d']);
});
