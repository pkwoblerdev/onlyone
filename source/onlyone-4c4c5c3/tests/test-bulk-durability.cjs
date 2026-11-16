const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { create } = require('../src/main/bulk-store');
const encode = x => ({data:x});
const decode = x => JSON.parse(x.data);
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(),'onlyone-durability-'));
async function main() {
  const failures=[];
  async function test(name, fn) {try {await fn();console.log('ok',name)} catch(e){failures.push(name+': '+e.message);console.error('FAIL',name,e.message)}}
  await test('unreadable legacy data is not migrated as an empty array', async()=>{
    let dropped=false,written=false;
    const store=create({dir:dir(),encode,decode,legacy:{has:()=>true,read:(_,fallback)=>fallback,drop:()=>{dropped=true},write:()=>{written=true}}});
    assert.deepEqual(store.get('conversations',[]),[]);
    assert.equal(dropped,false);
    assert.throws(()=>store.set('conversations',[]),/заблокирована/);
    assert.equal(written,false);
  });
  await test('quit persists an in-flight save, not just queued saves',async()=>{
    const folder=dir(),store=create({dir:folder,encode,decode});
    store.set('conversations',['new']);
    const writing=store.flush();
    store.flushSync();
    assert.deepEqual(create({dir:folder,encode,decode}).get('conversations',[]),['new']);
    await writing;
  });
  await test('failure of first file does not discard remaining dirty keys',async()=>{
    const folder=dir(),store=create({dir:folder,encode:x=>{if(x==='["fail"]')throw Error('disk unavailable');return encode(x)},decode});
    store.set('conversations',['fail']);store.set('designs',['keep']);
    await assert.rejects(store.flush());
    assert(store.pending()>=1);
    store.set('conversations',['fixed']);await store.flush();
    assert.deepEqual(create({dir:folder,encode,decode}).get('designs',[]),['keep']);
  });
  await test('late async completion cannot overwrite quit snapshot',async()=>{
    const folder=dir(),store=create({dir:folder,encode,decode});
    const original=fs.promises.writeFile;
    let resume,started;
    const paused=new Promise(resolve=>{started=resolve});
    fs.promises.writeFile=async (...args)=>{await original(...args);started();await new Promise(resolve=>{resume=resolve})};
    try{
      store.set('conversations',['old']);const pending=store.flush();await paused;
      store.set('conversations',['latest']);store.flushSync();resume();await pending;
      assert.deepEqual(create({dir:folder,encode,decode}).get('conversations',[]),['latest']);
    }finally{fs.promises.writeFile=original;resume?.()}
  });
  await test('unreadable data file that cannot be moved aside blocks writes',async()=>{
    const folder=dir(),file=path.join(folder,'conversations.json');
    fs.mkdirSync(folder,{recursive:true});
    fs.writeFileSync(file,'{не json');
    const original=fs.renameSync;
    fs.renameSync=()=>{throw Error('файл занят другой программой')};
    try{
      const store=create({dir:folder,encode,decode});
      assert.deepEqual(store.get('conversations',[['старое']]),[['старое']]);
      assert.throws(()=>store.set('conversations',['новое']),/заблокирована/);
      assert.equal(fs.readFileSync(file,'utf8'),'{не json','нечитаемый файл перезаписан');
    }finally{fs.renameSync=original}
  });
  await test('moved-aside corrupt file keeps its bytes and allows a new save',async()=>{
    const folder=dir(),file=path.join(folder,'designs.json');
    fs.mkdirSync(folder,{recursive:true});
    fs.writeFileSync(file,'{сломано');
    const store=create({dir:folder,encode,decode});
    assert.deepEqual(store.get('designs',[]),[]);
    store.set('designs',['заново']);
    await store.flush();
    const aside=fs.readdirSync(folder).find(name=>name.includes('.corrupt-'));
    assert(aside,'испорченный файл не убран в сторону');
    assert.equal(fs.readFileSync(path.join(folder,aside),'utf8'),'{сломано','убранный файл изменён');
    assert.deepEqual(create({dir:folder,encode,decode}).get('designs',[]),['заново']);
  });
  if(failures.length)throw Error(failures.join('\n'));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
