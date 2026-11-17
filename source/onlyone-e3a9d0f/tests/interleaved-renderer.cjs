const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'interleaved-ui-')))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,nodeIntegration:false}})
 await win.loadURL('data:text/html,<div id="answer"></div>')
 const source=fs.readFileSync(path.join(__dirname,'../src/renderer/app.js'),'utf8')
 const cut=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)))
 const report=await win.webContents.executeJavaScript(`(()=>{
   const t=x=>x;
   ${cut('  function thinkingHeadline(text)','  // A stored message is drawn')}
   ${cut('  function blockElement(block, isLive)','  // Дешёвая подпись блока')}
   const pane={blocks:[],paintedBlocks:[],assistantEl:document.getElementById('answer'),generating:true};
   const text='Проверяю preload: sendMessage существует. Это цельная фраза.';
   for(const char of text) for(const agent of ['Агент 2','Агент 3']) {
     pushThinking(pane,char,agent);paintBlocks(pane);
   }
   const rows=[...document.querySelectorAll('.think-row')];
   if(rows.length!==2)throw Error('Expected two thought rows, got '+rows.length);
   if(!rows.every(n=>n.querySelector('.think-body').textContent===text))throw Error('DOM lost or duplicated characters');
   if(!rows.every(n=>n.querySelector('.think-label').textContent==='Проверяю preload: sendMessage существует.'))throw Error('Fragmented headline');
   rows[0].open=true;
   pushThinking(pane,' Дополнение.','Агент 2');paintBlocks(pane);
   if(!rows[0].open)throw Error('Expanded row was replaced');
   pane.generating=false;paintBlocks(pane);
   if(document.querySelector('.think-row.live'))throw Error('Live state not cleared');
   return {ok:true,checks:5,rows:rows.length};
 })()`)
 console.log(JSON.stringify(report));win.destroy();app.exit(0)
}).catch(error=>{console.error(error);app.exit(1)})
