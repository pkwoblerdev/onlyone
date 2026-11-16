(function () {
  'use strict'
  const DENSITY_KEY='onlyone.mods.density'
  function density () { try { return localStorage.getItem(DENSITY_KEY)==='compact'?'compact':'normal' } catch { return 'normal' } }
  function setDensity (mode) { try { localStorage.setItem(DENSITY_KEY,mode) } catch {} }
  function emptyPanel (panel) { return !panel.status && Object.values(panel.counts||{}).every(value=>!Number(value)) }
  function applyDensity () {
    const mode=density()
    for(const host of document.querySelectorAll('.mods-panel-list, #desk-mods-body')) {
      host.dataset.density=mode
      const cards=Array.from(host.children).filter(child=>child.classList.contains('mod-card'))
      const note=Array.from(host.children).find(child=>child.classList.contains('mods-density-empty'))
      if(mode==='compact'&&cards.length&&cards.every(card=>card.hasAttribute('data-mods-empty'))&&host.__emptyText) {
        if(note)note.textContent=host.__emptyText
        else {const empty=document.createElement('p');empty.className='mods-density-empty';empty.textContent=host.__emptyText;host.append(empty)}
      } else note?.remove()
    }
    for(const control of document.querySelectorAll('.mods-density')) {
      const input=control.querySelector('input'),text=control.querySelector('span')
      if(input)input.checked=mode==='compact'
      if(text&&typeof control.__t==='function')text.textContent=control.__t('Плотно')
      if(control.tagName==='BUTTON'&&typeof control.__t==='function'){control.textContent=control.__t('Плотно');control.setAttribute('aria-checked',String(mode==='compact'))}
    }
  }
  function densityControl (t) {
    const label=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span')
    label.className='mods-density';label.__t=t;input.type='checkbox';input.checked=density()==='compact'
    text.textContent=t('Плотно')
    input.addEventListener('change',()=>{setDensity(input.checked?'compact':'normal');applyDensity()})
    label.append(input,text);return label
  }
  function decorate (host, view, t) {
    if(t)host.__emptyText=t('Нет включённых панелей. Установите мод в настройках Onlyone.')
    const cards=Array.from(host.children).filter(child=>child.classList.contains('mod-card'))
    cards.forEach((card,index)=>{const panel=view?.panels?.[index];if(panel&&emptyPanel(panel))card.dataset.modsEmpty='';else delete card.dataset.modsEmpty})
  }
  function mountDesk () {
    const panel=document.getElementById('desk-mods-panel'),body=document.getElementById('desk-mods-body')
    if(!panel||!body||panel.querySelector('.mods-density'))return
    const t=source=>document.documentElement.lang==='en'?(window.__I18N__?.en?.[source]||source):source
    // В Desk нет полей ввода: плотность переключается кнопкой-переключателем,
    // а не чекбоксом, иначе прогон «Desk без композера» справедливо краснеет.
    const control=document.createElement('button')
    control.type='button';control.className='mods-density mods-density-desk';control.__t=t
    control.setAttribute('role','switch');control.setAttribute('aria-label',t('Плотность'))
    control.textContent=t('Плотно');control.setAttribute('aria-checked',String(density()==='compact'))
    control.addEventListener('click',()=>{setDensity(density()==='compact'?'normal':'compact');applyDensity()})
    control.classList.add('desk-btn')
    panel.insertBefore(control,body)
  }
  function create ({api: electronAPI,t,getPane,chatOf,closeSettings}) {
    const {node,button,error,paint} = window.OnlyoneModPanels
    if (!electronAPI?.modsList) return null
    const host = document.getElementById('mods-manager')
    const entry = document.getElementById('mainMods')
    if (entry) entry.onclick = openPanels
    let view = null, preview = null, generation = 0, panelsDialog = null
    const message = node('p','','mod-feedback'); message.setAttribute('role','status')
    const intro=node('p',t('Моды добавляют панели, кнопки и поведение в Onlyone и Desk. Пакет API 1 описывает интерфейс и реакции на события.'))
    const note=node('p',t('Пакеты не запускают код. Задачи и навыки требуют отправки человеком. Счётчики событий действуют до перезапуска.'))
    const recovery=node('p',undefined,'mod-feedback'),list = node('div'), controls=node('div',undefined,'mod-controls')
    const densityToggle=densityControl(t)
    const skill=node('select'); skill.setAttribute('aria-label',t('Навык для примера'))
    const label=node('label',t('JSON-пакет мода'))
    const input=node('textarea',undefined,'mods-package'); input.maxLength=32768; input.spellcheck=false; input.id='mods-package';label.htmlFor=input.id
    const previewBox=node('section',undefined,'mod-card');previewBox.hidden=true
    const install=button(t('Установить и включить'),async()=>{
      if (!preview) return
      install.disabled=true
      try { const result=await electronAPI.modsCommit(preview.token); if(!result.ok) throw result; preview=null;previewBox.hidden=true;await refresh() }
      catch(result){message.textContent=error(t,result.code)}finally{install.disabled=false}
    })
    function showPreview (result) {
      preview=null;previewBox.hidden=true
      if (!result.ok) {message.textContent=error(t,result.code);return}
      preview=result;previewBox.replaceChildren(node('h3',result.package.name+' · '+result.package.version),node('p',result.package.description))
      previewBox.append(node('p',t('Разрешения пакета')))
      const permissions=node('ul'), names={'ui.panels':'Показывать панели','events.observe':'Наблюдать события без содержимого файлов','chat.draft':'Готовить задачи для отправки','desk.open':'Открывать Desk','skills.suggest':'Предлагать выбранный навык'}
      for (const value of result.package.permissions) permissions.append(node('li',t(names[value])))
      previewBox.append(permissions,node('p',t('Текст пакета станет инструкцией только после вашей отправки. Проверяйте задачи и источник мода.')),install,button(t('Отмена'),()=>{preview=null;previewBox.hidden=true}))
      previewBox.hidden=false;message.textContent=''
    }
    async function previewPackage (selection) {
      try {showPreview(await electronAPI.modsPreview(selection))}catch{message.textContent=error(t)}
    }
    const sample=button(t('Заполнить пример'),async()=>{
      try {const result=await electronAPI.modsSample({skillId:skill.value||undefined});if(!result.ok)throw result;input.value=JSON.stringify(result.package,null,2);preview=null;previewBox.hidden=true}
      catch{message.textContent=error(t)}
    })
    const inspect=button(t('Проверить пакет'),()=>previewPackage({package:input.value}))
    input.oninput=()=>{preview=null;previewBox.hidden=true}
    controls.append(densityToggle,skill,sample,inspect,button(t('Открыть панели'),openPanels))
    if (host) { host.classList.add('mods-manager'); host.replaceChildren(intro,note,recovery,message,list,label,input,controls,previewBox); } applyDensity()
    async function change (fn, element) {
      element.disabled=true
      try {const result=await fn();if(!result.ok)throw result;await refresh()}
      catch(result){message.textContent=error(t,result.code)}finally{element.disabled=false}
    }
    async function refresh () {
      const current=++generation
      try {
        const result=await electronAPI.modsList();if(current!==generation)return
        if(!result.ok)throw result
        view=result; if(entry)entry.hidden=!view.mods.some(item=>item.enabled&&item.package.panels.some(p=>p.surfaces.includes('main')));
        if (host) {
          list.replaceChildren(); const chosen=skill.value;skill.replaceChildren(new Option(t('Без навыка'),''))
        for(const item of view.skills.filter(s=>s.enabled))skill.append(new Option(item.name,item.id))
        if([...skill.options].some(o=>o.value===chosen))skill.value=chosen
        for(const item of view.mods) {
          const card=node('section',undefined,'mod-card'), pack=item.package
          const toggle=button(t(item.enabled?'Отключить':'Включить'),()=>change(()=>electronAPI.modsToggle({id:pack.id,enabled:!item.enabled,revision:view.revision}),toggle))
          const remove=button(t('Удалить мод'),()=>{
            const confirm=button(t('Подтвердить удаление'),()=>change(()=>electronAPI.modsRemove({id:pack.id,revision:view.revision}),confirm));remove.replaceWith(confirm)
          })
          const exportButton=button(t('Показать JSON'),async()=>{try{const result=await electronAPI.modsExport(pack.id);if(!result.ok)throw result;input.value=result.text;preview=null;previewBox.hidden=true;input.focus()}catch{message.textContent=error(t)}})
          const actions=node('div',undefined,'mod-controls');actions.append(toggle,remove,exportButton)
          if(item.history.length)actions.append(button(t('Проверить откат'),()=>previewPackage({rollback:pack.id})))
          card.append(node('h3',pack.name+' · '+pack.version),node('p',pack.description),node('small',pack.id),actions);list.append(card)
        }
        recovery.hidden=!view.recovery; recovery.replaceChildren()
        if(view.recovery)recovery.append(node('span',t('Файл модов был повреждён. Копия сохранена рядом:')+' '+view.recovery.archive+'. '+t('Восстановлено модов')+': '+view.recovery.restored+(view.recovery.dropped?'; '+t('потеряно')+': '+view.recovery.dropped:'')))
        if(!view.mods.length)list.append(node('p',t('Установленных модов нет')))
        message.replaceChildren(node('span',t('Событий в текущем сеансе')),node('span',': '+view.diagnostics.length))
        }
      } catch(result) { if(current===generation&&host)message.textContent=error(t,result.code) }
    }
    let dialogs=0
    function dialog (title) {
      const d=node('dialog',undefined,'mods-dialog'), header=node('header'), close=button(t('Закрыть'),()=>d.close()), heading=node('h2',t(title))
      heading.id='mods-dialog-title-'+(++dialogs);d.setAttribute('aria-labelledby',heading.id)
      header.append(heading,close);d.append(header);document.body.append(d)
      const opener=document.activeElement
      d.addEventListener('close',()=>{d.remove();const target=d.returnFocus||opener;if(target?.isConnected)target.focus()},{once:true})
      d.addEventListener('cancel',()=>{d.close()});d.showModal();return d
    }
    function offerDraft (result) {
      if (!result?.ok || result.type!=='draft')return
      const d=dialog('Задача от мода'), box=node('pre',result.text), feedback=node('p');feedback.setAttribute('role','status')
      d.append(node('p',result.modName+(result.skillName?' · '+result.skillName:'')),box,feedback,
        button(t('Вставить в строку ввода'),()=>{
          const pane=getPane(),chat=chatOf(pane)
          if(!chat || chat.id!==result.chatId || pane.generating || pane.preparing){feedback.textContent=t('Откройте исходный диалог и дождитесь окончания хода');return}
          if(pane.dom.textarea.value.trim()){feedback.textContent=t('Сначала очистите или отправьте текущий черновик');return}
          clearDraft(pane);pane.modAction=result.context;pane.dom.textarea.value=result.text
          const badge=button(t('Убрать действие мода'),()=>clearDraft(pane));badge.classList.add('mods-draft-badge');pane.modBadge=badge;pane.dom.form.append(badge)
          pane.dom.textarea.dispatchEvent(new Event('input',{bubbles:true}));d.returnFocus=pane.dom.textarea;closeSettings?.();if(panelsDialog?.isConnected){panelsDialog.returnFocus=pane.dom.textarea;panelsDialog.close()}d.close()
        }))
    }
    async function refreshPanels () {
      const d=panelsDialog;if(!d?.isConnected)return
      const pane=getPane(), chat=chatOf(pane),chatId=chat?.id
      const body=d.querySelector('.mods-panel-list')
      try {const result=await electronAPI.modsPanels(chatId);if(d===panelsDialog && d.isConnected && chatOf(getPane())?.id===chatId)paint(body,result,{t,action:input=>electronAPI.modAction({...input,chatId}),draft:offerDraft})}
      catch{body.textContent=error(t)}
    }
    function openPanels () {
      if(panelsDialog?.isConnected){panelsDialog.focus();return}
      panelsDialog=dialog('Моды');const densityBox=node('div',undefined,'mods-dialog-top');densityBox.append(densityControl(t));panelsDialog.append(densityBox,node('div',undefined,'mods-panel-list'));applyDensity();void refreshPanels()
    }
    function clearDraft (pane) {pane.modAction=null;pane.modBadge?.remove();pane.modBadge=null}
    function syncDraft (pane) {if(pane.modAction?.chatId!==chatOf(pane)?.id)clearDraft(pane)}
    function takeDraft (pane) {syncDraft(pane);const context=pane.modAction;clearDraft(pane);return context?{modAction:context}:null}
    const unsubscribe=electronAPI.onModsChanged?.(event=>{if(!event?.chatId)void refresh();void refreshPanels()})
    const unsubscribeDraft=electronAPI.onModDraft?.(offerDraft)
    window.addEventListener('beforeunload',()=>{unsubscribe?.();unsubscribeDraft?.()},{once:true})
    void refresh()
    return {refresh,openPanels,takeDraft,syncDraft}
  }
  const panels=window.OnlyoneModPanels
  if(panels&&!panels.__modsDensity) {
    const paint=panels.paint
    panels.paint=function (host,view,options) { const result=paint.call(this,host,view,options);decorate(host,view,options?.t);applyDensity();return result }
    panels.__modsDensity=true
  }
  if(document.getElementById('desk-mods-panel'))mountDesk()
  window.OnlyoneMods={create}
})()
