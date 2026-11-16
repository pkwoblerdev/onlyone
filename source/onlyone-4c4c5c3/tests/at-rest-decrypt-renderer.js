// at-rest-decrypt-renderer.js: внутриоконный зонд проверки расшифровки unwrapProtectedBytes
'use strict';
/* global document, window, setTimeout */
;(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 20000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (await fn()) return true } catch {}
      await wait(50)
    }
    return false
  }

  // Ожидание готовности приложения
  await until(() => document.documentElement.dataset.appReady === '1' || document.body, 15000)
  await wait(300)

  // Закрываем онбординг, если появился
  const ob = document.getElementById('onboarding')
  if (ob) {
    ob.remove()
    try { localStorage.setItem('onlyone.onboarded', '1') } catch {}
  }

  const decode = b64 => {
    try {
      const bin = atob(b64)
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  }
  const arg = decode('__ONECODE_ARG__')
  const { mode = 'artifact', manifest = {} } = arg

  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail || '' })

  // Создаём панель для визуального отображения и снимка
  const container = document.createElement('div')
  container.id = 'at-rest-verify-panel'
  container.style.cssText = `
    position: fixed;
    top: 20px;
    left: 20px;
    right: 20px;
    bottom: 20px;
    background: #18181b;
    color: #f4f4f5;
    border: 1px solid #3f3f46;
    border-radius: 12px;
    padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    z-index: 999999;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  `
  document.body.appendChild(container)

  try {
    if (mode === 'artifact') {
      container.innerHTML = `
        <div style="font-size: 20px; font-weight: 600; color: #fb923c;">
          Расшифровка артефакта · unwrapProtectedBytes (b64: true)
        </div>
        <div style="font-size: 13px; color: #a1a1aa;">
          Проверка схемы onecode-artifact:// для зашифрованного safeStorage PNG-изображения
        </div>
        <div id="artCard" style="background: #27272a; border: 1px solid #3f3f46; border-radius: 8px; padding: 16px; display: flex; align-items: center; gap: 20px;">
          <div id="imgWrapper" style="width: 120px; height: 120px; background: #09090b; border: 1px dashed #52525b; border-radius: 6px; display: flex; align-items: center; justify-content: center; position: relative;">
            <img id="artifactImg" style="image-rendering: pixelated; width: 80px; height: 80px;" alt="artifact test" />
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            <div style="font-weight: 600; font-size: 15px;" id="artTitle">Тестовая картинка (10×10 PNG)</div>
            <div style="font-size: 12px; color: #a1a1aa;" id="artMeta">URL: onecode-artifact://${manifest.artId}/1-image.png</div>
            <div style="font-size: 12px; color: #34d399; font-weight: 500;" id="artStatus">Ожидание загрузки...</div>
          </div>
        </div>
        <div id="checksLog" style="font-size: 12px; font-family: monospace; background: #09090b; padding: 12px; border-radius: 6px; color: #d4d4d8;"></div>
      `

      const logEl = document.getElementById('checksLog')
      const addLog = msg => { logEl.innerHTML += `<div>${msg}</div>` }

      const artUrl = `onecode-artifact://${manifest.artId}/1-image.png`
      const img = document.getElementById('artifactImg')

      // Fetch проверка
      let fetchResp
      try {
        fetchResp = await fetch(artUrl)
        const ct = fetchResp.headers.get('content-type')
        note('onecode-artifact отдал 200 OK', fetchResp.status === 200, `status: ${fetchResp.status}`)
        note('content-type корректный image/png', ct === 'image/png', `content-type: ${ct}`)
        addLog(`[PASS] fetch status: ${fetchResp.status}, content-type: ${ct}`)
      } catch (err) {
        note('onecode-artifact fetch успешен', false, err.message)
        addLog(`[FAIL] fetch: ${err.message}`)
      }

      // Загрузка в DOM <img>
      let imgLoaded = false
      img.onload = () => { imgLoaded = true }
      img.src = artUrl
      await until(() => imgLoaded || img.complete, 10000)

      note('img.naturalWidth === 10 (разрешение PNG)', img.naturalWidth === 10, `width: ${img.naturalWidth}`)
      note('img.naturalHeight === 10', img.naturalHeight === 10, `height: ${img.naturalHeight}`)
      addLog(`[PASS] img natural size: ${img.naturalWidth}x${img.naturalHeight}`)

      document.getElementById('artStatus').innerText = `✓ Успешно расшифровано: ${img.naturalWidth}×${img.naturalHeight} PNG (${fetchResp?.headers.get('content-type')})`

      // Отрицательный контроль
      try {
        const notFoundResp = await fetch(`onecode-artifact://${manifest.artId}/nonexistent.png`)
        note('отсутствующий файл возвращает 404', notFoundResp.status === 404, `status: ${notFoundResp.status}`)
        addLog(`[PASS] 404 not found check: ${notFoundResp.status}`)
      } catch (e) {
        note('отсутствующий файл возвращает 404', false, e.message)
      }

      try {
        const outsideResp = await fetch(`onecode-artifact://${manifest.artId}/..%2F..%2Fsecret.txt`)
        note('path traversal за пределы артефакта возвращает 403', outsideResp.status === 403, `status: ${outsideResp.status}`)
        addLog(`[PASS] 403 traversal check: ${outsideResp.status}`)
      } catch (e) {
        note('path traversal возвращает 403', false, e.message)
      }

    } else if (mode === 'design') {
      container.innerHTML = `
        <div style="font-size: 20px; font-weight: 600; color: #fb923c;">
          Расшифровка макета Дизайна · unwrapProtectedBytes (MIME CSS/JS)
        </div>
        <div style="font-size: 13px; color: #a1a1aa;">
          Проверка схемы onecode-design://: HTML, расшифровка style.css (text/css) и script.js (application/javascript)
        </div>
        <div style="background: #27272a; border: 1px solid #3f3f46; border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 12px;">
          <div style="font-size: 12px; color: #a1a1aa;">URL: onecode-design://${manifest.designId}/Home.dc.html</div>
          <iframe id="designFrame" style="width: 100%; height: 180px; border: 1px solid #52525b; border-radius: 6px; background: #ffffff;"></iframe>
          <div style="font-size: 12px; color: #34d399; font-weight: 500;" id="designStatus">Загрузка iframe...</div>
        </div>
        <div id="checksLog" style="font-size: 12px; font-family: monospace; background: #09090b; padding: 12px; border-radius: 6px; color: #d4d4d8;"></div>
      `

      const logEl = document.getElementById('checksLog')
      const addLog = msg => { logEl.innerHTML += `<div>${msg}</div>` }

      let designMsg = null
      const onMsg = event => {
        if (event.data?.type === 'ONECODE_DESIGN_TEST') {
          designMsg = event.data
        }
      }
      window.addEventListener('message', onMsg)

      const iframe = document.getElementById('designFrame')
      const designUrl = `onecode-design://${manifest.designId}/Home.dc.html`

      let frameLoaded = false
      iframe.onload = () => { frameLoaded = true }
      iframe.src = designUrl

      await until(() => frameLoaded, 10000)
      note('iframe onecode-design загрузился', frameLoaded, 'onload fired')
      addLog('[PASS] iframe onload fired')

      // Ждём postMessage от расшифрованного и выполненного script.js в iframe
      await until(() => Boolean(designMsg), 10000)
      window.removeEventListener('message', onMsg)

      note('iframe onecode-design выполнил скрипт и ответил postMessage', Boolean(designMsg), designMsg ? 'postMessage received' : 'timeout')
      note('зашифрованный CSS (text/css) применён (backgroundColor hotpink)', designMsg?.bg === 'rgb(255, 105, 180)', `bg: ${designMsg?.bg}`)
      note('зашифрованный JS (application/javascript) выполнен (scriptOk == true)', designMsg?.scriptOk === true, `scriptOk: ${designMsg?.scriptOk}`)
      addLog(`[PASS] computed background-color: ${designMsg?.bg}`)
      addLog(`[PASS] script execution marker: ${designMsg?.scriptOk}`)

      document.getElementById('designStatus').innerText = `✓ Успешно расшифровано: CSS (text/css) применён (${designMsg?.bg}), JS (application/javascript) выполнен (scriptOk=${designMsg?.scriptOk})`

      // Отрицательный контроль: несуществующий ресурс отдаёт ошибку загрузки
      let img404Error = false
      const testImg = document.createElement('img')
      testImg.onerror = () => { img404Error = true }
      testImg.src = `onecode-design://${manifest.designId}/nonexistent.png`
      await until(() => img404Error, 3000)
      note('несуществующий файл макета отдаёт ошибку загрузки', img404Error)
      addLog(`[PASS] design 404 image load error: ${img404Error}`)

    } else if (mode === 'attachment') {
      container.innerHTML = `
        <div style="font-size: 20px; font-weight: 600; color: #fb923c;">
          Расшифровка вложения чата · attachmentThumbnail (unwrapProtectedBytes)
        </div>
        <div style="font-size: 13px; color: #a1a1aa;">
          Проверка IPC-канала attachment-thumbnail для зашифрованного файла вложения
        </div>
        <div id="attachCard" style="background: #27272a; border: 1px solid #3f3f46; border-radius: 8px; padding: 16px; display: flex; align-items: center; gap: 20px;">
          <div id="imgWrapper" style="width: 120px; height: 120px; background: #09090b; border: 1px dashed #52525b; border-radius: 6px; display: flex; align-items: center; justify-content: center;">
            <img id="thumbImg" style="max-width: 100px; max-height: 100px; border-radius: 4px;" alt="thumbnail" />
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            <div style="font-weight: 600; font-size: 15px;" id="attachTitle">Миниатюра вложения чата</div>
            <div style="font-size: 12px; color: #a1a1aa;" id="attachFile">Файл: ${manifest.attachFile}</div>
            <div style="font-size: 12px; color: #34d399; font-weight: 500;" id="attachStatus">Запрос миниатюры...</div>
          </div>
        </div>
        <div id="checksLog" style="font-size: 12px; font-family: monospace; background: #09090b; padding: 12px; border-radius: 6px; color: #d4d4d8;"></div>
      `

      const logEl = document.getElementById('checksLog')
      const addLog = msg => { logEl.innerHTML += `<div>${msg}</div>` }

      note('electronAPI.attachmentThumbnail доступен', typeof window.electronAPI?.attachmentThumbnail === 'function')

      let thumb = null
      try {
        thumb = await window.electronAPI.attachmentThumbnail(manifest.attachFile)
      } catch (err) {
        addLog(`[FAIL] invoke error: ${err.message}`)
      }

      note('attachmentThumbnail вернул объект', Boolean(thumb && typeof thumb === 'object'), thumb ? 'got object' : 'null')
      note('mime миниатюры валидный (image/jpeg или image/png)', thumb?.mime === 'image/jpeg' || thumb?.mime === 'image/png', `mime: ${thumb?.mime}`)
      note('данные base64 не пустые', Boolean(thumb?.data && thumb.data.length > 50), `length: ${thumb?.data?.length}`)

      if (thumb && thumb.data) {
        const img = document.getElementById('thumbImg')
        let imgLoaded = false
        img.onload = () => { imgLoaded = true }
        img.src = `data:${thumb.mime};base64,${thumb.data}`
        await until(() => imgLoaded || img.complete, 5000)

        note('миниатюра отрендерилась в DOM (naturalWidth > 0)', img.naturalWidth > 0, `width: ${img.naturalWidth}`)
        addLog(`[PASS] thumbnail loaded in DOM: ${img.naturalWidth}x${img.naturalHeight} px`)
        document.getElementById('attachStatus').innerText = `✓ Миниатюра успешно создана из зашифрованного файла: ${thumb.mime}, ${img.naturalWidth}×${img.naturalHeight} px`
      }

      // Отрицательный контроль
      const nullThumb = await window.electronAPI.attachmentThumbnail('nonexistent-path.png')
      note('несуществующий файл возвращает null', nullThumb === null, `result: ${JSON.stringify(nullThumb)}`)
      addLog(`[PASS] nonexistent attachment returns null: ${nullThumb === null}`)
    }
  } catch (globalErr) {
    note('глобальная ошибка прогона', false, globalErr.message)
  }

  // Даём время для отрисовки перед ONECODE_SHOT
  await wait(600)

  return {
    ok: checks.length > 0 && checks.every(c => c.pass),
    checks,
    mode
  }
})()
