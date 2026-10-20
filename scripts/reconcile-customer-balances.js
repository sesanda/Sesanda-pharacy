// Customer balance reconciliation — READ-ONLY.
//
// Compares each customer's stored running total (customers.dueAmount) with the outstanding
// amount recomputed from their unpaid bills — the same figures the Customers tab shows — and
// lists every mismatch, plus unpaid bills not linked to any customer record. Nothing is written
// to Firestore: the script only calls .get().
//
// How to run (no keys or passwords needed — it uses your normal staff login):
//   1. Open the live app, go to Staff / Admin Portal and sign in.
//   2. Open the browser console (F12 → Console).
//   3. Paste this whole file and press Enter.
// It prints a summary + tables and downloads reconcile-customer-balances-<date>.csv.
//
// The two balance helpers below are verbatim copies from index.html;
// tests/reconcile-script.test.mjs fails if they ever drift apart.
(function(){

function invoiceBalanceInfo(inv){
  const total = Number(inv.totalToPay)||0;
  const paidAmt = inv.paidAmount!=null ? (Number(inv.paidAmount)||0) : (inv.payment!=='credit' || inv.paid ? total : 0);
  const balance = Math.max(0, total - paidAmt);
  // A cash/card bill that was only partly paid (paidAmount < total) carries a real balance that
  // billing added to the customer's due — it must not be reported as PAID.
  const isPaid = inv.payment!=='credit' ? balance<=0.001 : (inv.paid || balance<=0.001);
  return {total, paidAmt, balance: isPaid ? 0 : balance, isPaid};
}

function computeCustomerOutstanding(customers, invoices){
  const byCustomer = {};
  const unlinked = []; // invoices with a balance but no matching customer record
  const seen = new Set();
  const custIds = new Set((customers||[]).map(c=>c.id));
  (invoices||[]).forEach(inv=>{
    if(!inv || !inv.id || seen.has(inv.id)) return;
    seen.add(inv.id);
    const info = invoiceBalanceInfo(inv);
    if(info.balance<=0.001) return;
    if(!inv.customerId || !custIds.has(inv.customerId)){ unlinked.push({inv, ...info}); return; }
    const row = byCustomer[inv.customerId] || (byCustomer[inv.customerId] = {outstanding:0, openBills:0});
    row.outstanding += info.balance; row.openBills += 1;
  });
  const result = {};
  (customers||[]).forEach(c=>{
    const r = byCustomer[c.id] || {outstanding:0, openBills:0};
    const outstanding = Math.round(r.outstanding*100)/100;
    const storedDue = Math.round((Number(c.dueAmount)||0)*100)/100;
    result[c.id] = { outstanding, openBills:r.openBills, storedDue, mismatch: Math.abs(outstanding-storedDue)>0.009 };
  });
  const total = Math.round(Object.values(result).reduce((s,r)=>s+r.outstanding,0)*100)/100;
  const storedTotal = Math.round(Object.values(result).reduce((s,r)=>s+r.storedDue,0)*100)/100;
  return { byId: result, total, storedTotal, unlinked, mismatchCount: Object.values(result).filter(r=>r.mismatch).length };
}

const toMs = v => v && typeof v.toMillis==='function' ? v.toMillis() : (typeof v==='number' ? v : null);
const day = ms => ms ? new Date(ms).toISOString().slice(0,10) : '';

// Pure report builder (no Firestore) so it can be unit tested.
function buildReport(customers, invoices, payments){
  const info = computeCustomerOutstanding(customers, invoices);
  const lastPayment = {};
  (payments||[]).forEach(p=>{
    const ms = toMs(p.createdAt);
    const cur = lastPayment[p.customerId];
    if(p.customerId && (!cur || (ms||0) > (cur.ms||0))) lastPayment[p.customerId] = {ms, amount:Number(p.amount)||0};
  });
  const mismatches = (customers||[])
    .filter(c=> info.byId[c.id].mismatch)
    .map(c=>{
      const r = info.byId[c.id], lp = lastPayment[c.id];
      return {
        customerId: c.id, name: c.name||'', tel: c.tel||'', code: c.code||'',
        storedDue: r.storedDue, fromBills: r.outstanding,
        difference: Math.round((r.storedDue - r.outstanding)*100)/100, // + = stored is higher than bills
        openBills: r.openBills,
        lastPayment: lp ? day(lp.ms) : '', lastPaymentAmount: lp ? lp.amount : '',
      };
    })
    .sort((a,b)=> Math.abs(b.difference) - Math.abs(a.difference));
  const unlinked = info.unlinked.map(u=>({
    invoiceId: u.inv.id, billNo: u.inv.billNo||'', customerId: u.inv.customerId||'',
    customerName: u.inv.customerName||'', customerTel: u.inv.customerTel||'',
    payment: u.inv.payment||'', total: u.total, balance: Math.round(u.balance*100)/100,
    date: day(u.inv.createdAtMs || toMs(u.inv.createdAt)),
  }));
  return {
    summary: {
      customers: (customers||[]).length, invoices: (invoices||[]).length,
      totalFromBills: info.total, totalStored: info.storedTotal,
      totalDifference: Math.round((info.storedTotal - info.total)*100)/100,
      mismatchedCustomers: mismatches.length, unlinkedUnpaidBills: unlinked.length,
    },
    mismatches, unlinked,
  };
}

function toCsv(report){
  const esc = v => { const s = String(v==null?'':v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  const lines = [];
  const section = (title, rows) => {
    lines.push(title);
    if(!rows.length){ lines.push('(none)', ''); return; }
    const cols = Object.keys(rows[0]);
    lines.push(cols.join(','));
    rows.forEach(r=> lines.push(cols.map(k=>esc(r[k])).join(',')));
    lines.push('');
  };
  section('Summary', [report.summary]);
  section('Customers whose stored due differs from their bills', report.mismatches);
  section('Unpaid bills not linked to a customer record', report.unlinked);
  return lines.join('\n');
}

async function run(){
  const fb = window.firebase;
  if(!fb || !fb.apps || !fb.apps.length) throw new Error('Run this on the pharmacy app page (Firebase not found).');
  if(!fb.auth().currentUser) throw new Error('Sign in to the Staff / Admin Portal first, then run this again.');
  const db = fb.firestore();
  const read = async name => (await db.collection(name).get()).docs.map(d=>({id:d.id, ...d.data()}));
  console.log('Reading customers, invoices and payments (read-only)...');
  const [customers, invoices, payments] = await Promise.all([read('customers'), read('invoices'), read('payments')]);
  const report = buildReport(customers, invoices, payments);
  console.log('%cCustomer balance reconciliation', 'font-weight:bold;font-size:14px');
  console.table([report.summary]);
  console.log(report.mismatches.length ? 'Customers whose stored due differs from their bills (difference + = stored is higher):' : 'No stored-due mismatches.');
  if(report.mismatches.length) console.table(report.mismatches);
  console.log(report.unlinked.length ? 'Unpaid bills not linked to a customer record:' : 'No unlinked unpaid bills.');
  if(report.unlinked.length) console.table(report.unlinked);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toCsv(report)], {type:'text/csv'}));
  a.download = 'reconcile-customer-balances-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  console.log('Nothing was changed in the database. CSV downloaded: ' + a.download);
  return report;
}

if(typeof module!=='undefined' && module.exports) module.exports = { invoiceBalanceInfo, computeCustomerOutstanding, buildReport, toCsv };
else run().catch(e=> console.error('Reconcile failed:', e.message || e));

})();
