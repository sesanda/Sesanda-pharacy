// In-memory Firebase compat stub for browser tests. Mimics the production Firestore rules that were
// verified live: protected collections reject reads while signed out, and — like real Firestore —
// a listener that errors is closed for good. SYNTHETIC data only (window.__FIXTURE__).
(function(){
  const PUBLIC = new Set(['items','batches','orders','specialOrders','invoices','vitals','healthReports']);
  const fx = window.__FIXTURE__ || {};
  const store = {}; Object.keys(fx.collections||{}).forEach(k=> store[k] = (fx.collections[k]||[]).map(d=>({...d})));
  const failCollections = new Set(fx.failCollections||[]); // simulate a hard Firestore error
  let currentUser = null; const authCbs = new Set(); window.__writes = [];
  const snap = (name)=>({ docs:(store[name]||[]).map(d=>({id:d.id, data:()=>{ const {id,...rest}=d; return rest; }})), size:(store[name]||[]).length, empty:!(store[name]||[]).length, forEach(f){ this.docs.forEach(f); } });
  const err = (code)=>{ const e = new Error(code); e.code = code; return e; };
  const listeners = new Set();
  const notify = (name)=> listeners.forEach(l=>{ if(l.name===name && !l.closed) l.next(snap(name)); });
  function canRead(name){ if(failCollections.has(name)) return 'unavailable'; if(!currentUser && !PUBLIC.has(name)) return 'permission-denied'; return null; }
  function docRef(name, id){
    id = id || ('auto' + Math.random().toString(36).slice(2,8));
    return { id, get: async()=>{ const d=(store[name]||[]).find(x=>x.id===id); return {exists:!!d, id, data:()=>d?{...d}:undefined}; },
      set: async(v)=>{ window.__writes.push({op:'set',name,id,v}); }, update: async(v)=>{ window.__writes.push({op:'update',name,id,v}); },
      delete: async()=>{ window.__writes.push({op:'delete',name,id}); }, onSnapshot(){ return ()=>{}; } };
  }
  function query(name){
    const q = { where:()=>q, orderBy:()=>q, limit:()=>q,
      get: async()=>{ const c=canRead(name); if(c) throw err(c); return snap(name); },
      onSnapshot(next, onErr){
        const l = {name, next, closed:false}; listeners.add(l);
        setTimeout(()=>{ const c=canRead(name); if(c){ l.closed = true; onErr && onErr(err(c)); } else next(snap(name)); }, 5);
        return ()=>{ l.closed = true; listeners.delete(l); };
      },
      add: async(v)=>{ window.__writes.push({op:'add',name,v}); return docRef(name); },
      doc: (id)=> docRef(name, id) };
    return q;
  }
  const db = { collection: query, batch: ()=>({ set(){}, update(r,v){ window.__writes.push({op:'batch.update',v}); }, delete(){}, commit: async()=>{} }),
    runTransaction: async(fn)=> fn({ get: async(r)=> r.get(), set(){}, update(){} }) };
  const firestore = ()=> db; firestore.FieldValue = { serverTimestamp: ()=>({__ts:true}), increment:n=>n, arrayUnion:(...a)=>a, delete:()=>null };
  firestore.Timestamp = { now: ()=>({toMillis:()=>Date.now()}) };
  const auth = ()=>({
    get currentUser(){ return currentUser; },
    onAuthStateChanged(cb){ authCbs.add(cb); setTimeout(()=>cb(currentUser),0); return ()=>authCbs.delete(cb); },
    signInWithEmailAndPassword: async(email)=>{ currentUser = {uid:'test-uid', email}; authCbs.forEach(cb=>cb(currentUser)); return {user:currentUser}; },
    signOut: async()=>{ currentUser = null; authCbs.forEach(cb=>cb(null)); },
  });
  window.firebase = { apps:[], initializeApp(){ this.apps.push({}); return {}; }, firestore, auth, __notify:notify, __store:store };
})();
