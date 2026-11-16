// Isolated Electron DOM test of the production question-card listener.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), '1code-question-ui-')))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } })
  await win.loadURL('data:text/html,<div id="chat"></div><div id="designMessages"></div>')
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8')
  const start = src.indexOf('    window.electronAPI.onAgentQuestion?.(request => {')
  const end = src.indexOf('    window.electronAPI.onAgentApproval(', start)
  if (start < 0 || end < 0) throw new Error('Question listener missing')
  const result = await win.webContents.executeJavaScript(`(async () => {
    let listener, rejectAnswer = false, answers = [], checks = 0;
    const assert = (ok, label) => { checks++; if (!ok) throw Error(label) };
    const $ = id => document.getElementById(id);
    const questionCards = new Map();
    const designRun = { requestId: 'design-r', design: { id: 'd1' } };
    const pane = { chatId: 'c1', dom: { list: $('chat') } };
    const paneForRequest = id => id === 'chat-r' ? pane : null;
    const scrollToBottom = () => {};
    const cleanErrorText = String, showToast = () => {};
    const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    window.electronAPI = {
      onAgentQuestion: fn => listener = fn,
      resolveAgentQuestion: async answer => { if (rejectAnswer) throw Error('test failure'); answers.push(answer) }
    };
    ${src.slice(start, end)}
    const options = [{label:'A',svg:'<svg xmlns="http://www.w3.org/2000/svg" onload="window.svgExecuted=true"></svg>'},{label:'B'}];
    listener({id:'q1',requestId:'design-r',question:'Direction?',options});
    assert($('designMessages').querySelectorAll('.ask-card').length === 1, 'Design routing');
    assert(!$('chat').children.length, 'Design must not leak into chat');
    assert(!$('designMessages').querySelector('svg'), 'SVG must not be inserted as active DOM');
    await new Promise(r => setTimeout(r, 40));
    assert(!window.svgExecuted, 'SVG event handler executed');
    const card = $('designMessages').querySelector('.ask-card');
    rejectAnswer = true; card.querySelector('button').click();
    await new Promise(r => setTimeout(r, 10));
    assert(!card.querySelector('button').disabled, 'failed answer must allow retry');
    assert(!card.querySelector('.ask-answered'), 'failed answer must not appear accepted');
    rejectAnswer = false; card.querySelector('button').click();
    await new Promise(r => setTimeout(r, 10));
    assert(answers.length === 1 && answers[0].answer === 'A', 'answer round trip');
    listener({id:'q1',requestId:'design-r',closed:true});
    assert(!questionCards.has('q1'), 'closed question retained');
    listener({id:'q2',requestId:'chat-r',question:'Chat?',options});
    assert($('chat').querySelectorAll('.ask-card').length === 1, 'chat routing');
    listener({id:'q3',requestId:'unknown',question:'Wrong chat?',options});
    assert($('chat').querySelectorAll('.ask-card').length === 1, 'orphan request routed to active chat');
    return {ok:true, checks};
  })()`)
  console.log(JSON.stringify(result))
  win.destroy()
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
