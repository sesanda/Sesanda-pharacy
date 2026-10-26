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
  // Writes are logged in window.__writes AND applied to the in-memory store (live listeners are
  // notified), so flows that write then read back — e.g. create a journal, then post it — work.
  const apply = {
    set(name, id, v){ const list = store[name] || (store[name] = []); const i = list.findIndex(x=>x.id===id); const doc = {...v, id}; if(i>=0) list[i] = doc; else list.push(doc); notify(name); },
    update(name, id, v){ const d = (store[name]||[]).find(x=>x.id===id); if(d) Object.assign(d, v); notify(name); },
    delete(name, id){ if(store[name]) store[name] = store[name].filter(x=>x.id!==id); notify(name); },
  };
  function docRef(name, id){
    id = id || ('auto' + Math.random().toString(36).slice(2,8));
    return { id, __name:name, get: async()=>{ const d=(store[name]||[]).find(x=>x.id===id); return {exists:!!d, id, data:()=>d?{...d}:undefined}; },
      set: async(v, o)=>{ window.__writes.push({op:'set',name,id,v}); if(o && o.merge){ const d=(store[name]||[]).find(x=>x.id===id); apply.set(name, id, {...(d||{}), ...v}); } else apply.set(name, id, v); },
      update: async(v)=>{ window.__writes.push({op:'update',name,id,v}); apply.update(name, id, v); },
      delete: async()=>{ window.__writes.push({op:'delete',name,id}); apply.delete(name, id); }, onSnapshot(){ return ()=>{}; } };
  }
  function query(name){
    const q = { where:()=>q, orderBy:()=>q, limit:()=>q,
      get: async()=>{ const c=canRead(name); if(c) throw err(c); return snap(name); },
      onSnapshot(next, onErr){
        const l = {name, next, closed:false}; listeners.add(l);
        setTimeout(()=>{ const c=canRead(name); if(c){ l.closed = true; onErr && onErr(err(c)); } else next(snap(name)); }, 5);
        return ()=>{ l.closed = true; listeners.delete(l); };
      },
      add: async(v)=>{ window.__writes.push({op:'add',name,v}); const r = docRef(name); apply.set(name, r.id, v); return r; },
      doc: (id)=> docRef(name, id) };
    return q;
  }
  const db = { collection: query,
    batch: ()=>{ const ops = []; return {
      set(r,v,o){ ops.push(()=> o&&o.merge ? apply.set(r.__name, r.id, {...((store[r.__name]||[]).find(x=>x.id===r.id)||{}), ...v}) : apply.set(r.__name, r.id, v)); window.__writes.push({op:'batch.set',name:r.__name,v}); },
      update(r,v){ ops.push(()=> apply.update(r.__name, r.id, v)); window.__writes.push({op:'batch.update',name:r.__name,v}); },
      delete(r){ ops.push(()=> apply.delete(r.__name, r.id)); window.__writes.push({op:'batch.delete',name:r.__name}); },
      commit: async()=>{ ops.forEach(f=>f()); } }; },
    runTransaction: async(fn)=> fn({ get: async(r)=> r.get(),
      set(r,v,o){ window.__writes.push({op:'tx.set',name:r.__name,v}); const d=(store[r.__name]||[]).find(x=>x.id===r.id); apply.set(r.__name, r.id, o&&o.merge ? {...(d||{}), ...v} : v); },
      update(r,v){ window.__writes.push({op:'tx.update',name:r.__name,v}); apply.update(r.__name, r.id, v); } }) };
  const firestore = ()=> db; firestore.FieldValue = { serverTimestamp: ()=>({__ts:true}), increment:n=>n, arrayUnion:(...a)=>a, delete:()=>null };
  firestore.Timestamp = { now: ()=>({toMillis:()=>Date.now()}), fromMillis: (ms)=>({toMillis:()=>ms}) };
  const auth = ()=>({
    get currentUser(){ return currentUser; },
    onAuthStateChanged(cb){ authCbs.add(cb); setTimeout(()=>cb(currentUser),0); return ()=>authCbs.delete(cb); },
    signInWithEmailAndPassword: async(email)=>{ currentUser = {uid:'test-uid', email}; authCbs.forEach(cb=>cb(currentUser)); return {user:currentUser}; },
    signOut: async()=>{ currentUser = null; authCbs.forEach(cb=>cb(null)); },
  });
  window.firebase = { apps:[], initializeApp(){ this.apps.push({}); return {}; }, firestore, auth, __notify:notify, __store:store };
})();
