// The tools a design turn is given.
//
// This set replaces the workspace file tools rather than joining them: a design
// lives in its own store, and handing the model `write_file` alongside `dc_write`
// invites it to write a stray .html into the user's project instead of a Design
// Component into the design.
const schema = (name, description, properties, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } }
})

const PATH_PROP = {
  type: 'string',
  description: 'Имя компонента, например "Landing Page.dc.html". Без папок.'
}

function designToolSchemas() {
  return [
    schema('dc_write',
      'Создать Design Component или полностью заменить существующий. Три части собираются в файл автоматически: обёртка документа, <x-dc> и подключение среды выполнения добавляются за тебя — их писать не нужно. ВНИМАНИЕ: содержимое заменяется целиком. Если компонент уже есть, сначала прочитай его через dc_read, иначе сотрёшь сделанное.',
      {
        path: PATH_PROP,
        b_dc_html: { type: 'string', description: 'Разметка между <x-dc> и </x-dc>. Без самих тегов <x-dc>, без <script>, без обёртки документа.' },
        c_dc_js: { type: 'string', description: 'Исходник класса логики: class Component extends DCLogic { … }. Без тега <script>. Пусто, если дизайн только из разметки.' },
        d_props_json: { type: 'string', description: 'JSON для data-props. Необязательно. $preview задаёт размер превью: {"$preview":{"width":1440,"height":920}}.' }
      },
      ['path', 'b_dc_html']),

    schema('dc_check',
      'Проверить настоящий рендер компонента на ширинах 1280 и 375: пустое превью, ошибки JS, горизонтальное переполнение и изображения. Это проверка на сломанное, не оценка эстетики.',
      { path: PATH_PROP }, ['path']),

    schema('dc_scaffold',
      'Собрать каркас целого сайта или приложения одним вызовом: kind=site — страницы с общими шапкой и подвалом и работающими ссылками между собой (при одной странице или списке секций собирает полноценный адаптивный веб-сайт с якорной навигацией без телефонной рамки); kind=app — экраны мобильного приложения в корпусе телефона с общей нижней навигацией. Палитра, шкала кеглей, радиусы и шаг сетки считаются по правилам и впечатываются во все файлы сразу — именно это делает набор страниц одним сайтом, потому что общего CSS здесь нет. Входная страница выбирается сама. Дальше наполняешь страницы работой: каркас — скелет, а не результат.',
      {
        kind: { type: 'string', enum: ['site', 'app'], description: 'site — сайт из страниц; app — экраны приложения.' },
        pages: {
          type: 'array',
          description: 'От одной до восьми страниц или секций. Одна страница создаёт адаптивный одностраничный сайт (лендинг) с якорной навигацией без телефонного корпуса. Две и более страниц собирают многостраничный сайт. Первая страница становится главной или входной.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Имя файла без расширения: Home, Pricing, Profile.' },
              title: { type: 'string', description: 'Как страница называется в навигации.' },
              purpose: { type: 'string', description: 'Одна строка: зачем страница нужна.' },
              headline: { type: 'string', description: 'Для главной или лендинга: обещание в несколько слов.' },
              sections: {
                type: 'array',
                description: 'Для одностраничного сайта: список секций (id, title, purpose/desc).',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Идентификатор секции для якорной ссылки (#hero, #features, #pricing, #contact).' },
                    title: { type: 'string', description: 'Заголовок секции.' },
                    purpose: { type: 'string', description: 'Назначение или описание секции.' }
                  }
                }
              }
            },
            required: ['name']
          }
        },
        sections: {
          type: 'array',
          description: 'Список секций для одностраничного сайта: id, title, purpose.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Идентификатор секции для якоря (#hero, #features, #pricing, #contact).' },
              title: { type: 'string', description: 'Заголовок секции.' },
              purpose: { type: 'string', description: 'Назначение секции.' }
            }
          }
        },
        tokens: {
          type: 'object',
          description: 'Направление оформления. Всё необязательно, у каждого есть разумное значение.',
          properties: {
            bg: { type: 'string', description: 'Фон страницы.' },
            surface: { type: 'string', description: 'Фон карточек и блоков.' },
            ink: { type: 'string', description: 'Основной текст.' },
            muted: { type: 'string', description: 'Второстепенный текст.' },
            line: { type: 'string', description: 'Границы и разделители.' },
            accent: { type: 'string', description: 'Акцент: кнопки, активное состояние.' },
            onAccent: { type: 'string', description: 'Текст поверх акцента.' },
            font: { type: 'string', description: 'Семейство основного текста.' },
            display: { type: 'string', description: 'Семейство заголовков.' },
            baseSize: { type: 'integer', description: 'Кегль основного текста, 14–20.' },
            ratio: { type: 'number', description: 'Отношение шкалы кеглей, 1.15–1.6.' },
            unit: { type: 'integer', description: 'Шаг сетки, 4–12.' },
            radius: { type: 'integer', description: 'Радиус скругления, 0–32.' }
          }
        }
      },
      ['kind', 'pages']),

    schema('dc_export',
      'Выгрузить готовый компонент файлом: format=png — снимок всей страницы целиком, format=pdf — документ. Файл кладётся рядом с дизайном, путь возвращается. Делай это, когда работа закончена и проверена, а не вместо проверки.',
      {
        path: PATH_PROP,
        format: { type: 'string', enum: ['png', 'pdf'], description: 'png — картинка, pdf — документ.' },
        width: { type: 'integer', description: 'Ширина рендера в пикселях, по умолчанию 1440.' }
      }, ['path']),

    schema('dc_imagery',
      'Собрать оформление, которое можно построить, а не сфотографировать: kind=mesh — градиентное поле, grain — зерно поверх заливки, pattern — повторяющийся мотив, duotone — двухцветная обработка, placeholder — полосатая заглушка. Возвращает готовый CSS или data-URL. Заглушка нужна только там, где обязана быть настоящая фотография или логотип; узор, текстуру и декоративную подложку строй, а не заглушай. Без kind — список.',
      {
        kind: { type: 'string', enum: ['mesh', 'grain', 'pattern', 'duotone', 'placeholder'], description: 'Какое оформление. Без него вернётся список.' },
        colors: { type: 'array', items: { type: 'string' }, description: 'Цвета из палитры дизайна, от одного до трёх. CSS-значения.' },
        label: { type: 'string', description: 'Подпись для заглушки: «фото продукта», «логотип».' },
        seed: { type: 'integer', description: 'Выбор мотива для pattern.' }
      }, []),

    schema('dc_starter',
      'Взять готовый каркас с отлаженной механикой: kind=slide — сцена слайда 1920×1080, которая сама вписывается в предпросмотр; doc — печатная страница с читаемой полосой; options — галерея вариантов с номерами; phone — экран телефона 390×844 с безопасными полями. Возвращает разметку и логику: дальше меняешь содержимое, типографику и композицию под задачу. Без kind — список заготовок.',
      { kind: { type: 'string', enum: ['slide', 'doc', 'options', 'phone'], description: 'Какой каркас. Без него вернётся список.' } }, []),

    schema('dc_reference',
      'Разбор типовой работы: из чего состоит страница такого рода, чем один вид отличается от другого и что чаще всего портит результат. kind=landing, dashboard, portfolio, pricing, article. Без kind — список разборов. Читай до того, как начнёшь: это не картинки, а устройство.',
      { kind: { type: 'string', enum: ['landing', 'dashboard', 'portfolio', 'pricing', 'article'], description: 'Какой разбор. Без него вернётся список.' } }, []),

    schema('dc_screenshot',
      'Посмотреть на отрисованную страницу своими глазами: снимок возвращается в переписку картинкой. view=desktop — 1280, view=mobile — 390. Это единственный способ увидеть сделанное: проверка и замер говорят о свойствах, а не о виде. Смотри до того, как назвать работу готовой, и после каждой существенной правки композиции. Модель без ввода изображений получит отказ, а не выдуманное описание.',
      {
        path: PATH_PROP,
        view: { type: 'string', enum: ['desktop', 'mobile'], description: 'Ширина снимка.' }
      }, ['path']),

    schema('dc_measure',
      'Измерить отрисованную страницу и получить числа: шкала кеглей с образцами текста, места с контрастом ниже нормы, ритм отступов, палитра по занимаемой площади, цели меньше 44px, длина строки в знаках, применённые шрифты. Это то, чем проверяют решения: написанное в коде и отрисованное — разные вещи. Вызывай после сборки страницы, до того как назвать работу законченной.',
      { path: PATH_PROP }, ['path']),

    schema('dc_set_entry',
      'Выбрать готовую основную страницу для предпросмотра. После сборки вызови с путём страницы, а не вспомогательного компонента.',
      { path: PATH_PROP }, ['path']),

    schema('dc_read',
      'Прочитать Design Component: разметку, логику и props по отдельности. Делай это перед любой заменой через dc_write.',
      { path: PATH_PROP },
      ['path']),

    schema('dc_list',
      'Список Design Components в этом дизайне.',
      {}, []),

    schema('dc_html_str_replace',
      'Заменить один точный фрагмент в разметке. Предпочтительно вместо перезаписи файла: правится только то, что просили. Фрагмент должен встречаться ровно один раз — иначе замена отклоняется.',
      {
        path: PATH_PROP,
        old_str: { type: 'string', description: 'Точный текст, который нужно заменить. Должен быть единственным в разметке.' },
        new_str: { type: 'string', description: 'Текст на замену. Пустая строка удаляет фрагмент.' }
      },
      ['path', 'old_str', 'new_str']),

    schema('dc_js_str_replace',
      'То же самое для класса логики.',
      {
        path: PATH_PROP,
        old_str: { type: 'string', description: 'Точный текст в логике. Должен быть единственным.' },
        new_str: { type: 'string', description: 'Текст на замену.' }
      },
      ['path', 'old_str', 'new_str']),

    schema('dc_set_props',
      'Заменить JSON в data-props, не трогая разметку и логику.',
      {
        path: PATH_PROP,
        d_props_json: { type: 'string', description: 'Новый JSON целиком.' }
      },
      ['path', 'd_props_json']),

    schema('dc_delete',
      'Удалить Design Component. Пользователь подтверждает операцию.',
      { path: PATH_PROP },
      ['path']),

    schema('dc_refs',
      'Список референсов, которые приложил пользователь: фото, архивы, брифы, наборы иконок. Смотри его перед началом работы — если что-то приложено, это и есть образец, на который опираться.',
      {}, []),

    schema('dc_read_ref',
      'Прочитать текстовый референс: бриф, JSON с токенами, CSS, SVG. Картинки и бинарные файлы прочитать нельзя — на них ссылаются из макета по пути refs/<имя>.',
      {
        path: { type: 'string', description: 'Имя из dc_refs, например "бриф.md" или "kit/icons/home.svg".' }
      },
      ['path']),

    schema('dc_comments',
      'Замечания, которые пользователь оставил на превью. У каждого есть якорь data-comment-anchor и описание элемента, к которому оно приколото.',
      {}, []),

    schema('dc_resolve_comment',
      'Отметить замечание выполненным. Только после того, как правка действительно сделана.',
      { anchor: { type: 'string', description: 'Значение data-comment-anchor этого замечания.' } },
      ['anchor'])
  ]
}

const DESIGN_TOOL_NAMES = new Set(designToolSchemas().map(t => t.function.name))

// `comments` is the live list for this design; `confirm` asks the user before a
// destructive step, matching how the workspace tools behave.
async function executeDesignTool({ store, designId, name, args, comments, confirm, notify, check, measure, exportFile, shoot }) {
  const say = message => { try { notify?.(message) } catch {} }
  if (name === 'dc_check') {
    const component = await store.read(designId, args.path)
    if (!check) return { success: false, error: 'Среда проверки недоступна' }
    return check(component.name)
  }

  if (name === 'dc_scaffold') {
    const { scaffold, buildScaffold } = require('./scaffold')
    say('Собираю каркас: ' + (args.kind || 'site'))
    const fn = (args.kind === 'site' && Array.isArray(args.pages) && args.pages.length === 1) ? buildScaffold : scaffold
    return fn({ store, designId, kind: args.kind, pages: args.pages, tokens: args.tokens, sections: args.sections })
  }

  if (name === 'dc_export') {
    const component = await store.read(designId, args.path)
    if (!exportFile) return { success: false, error: 'Выгрузка недоступна' }
    say('Выгружаю ' + (args.format || 'png'))
    return exportFile(component.name, args.format || 'png', args.width)
  }

  if (name === 'dc_imagery') {
    const { imagery } = require('./imagery')
    if (args.kind) say('Собираю оформление: ' + args.kind)
    return imagery(args || {})
  }

  if (name === 'dc_starter') {
    const { starter, starterList } = require('./starters')
    if (!args.kind) return { success: true, starters: starterList() }
    say('Беру каркас: ' + args.kind)
    return starter(args.kind)
  }

  if (name === 'dc_reference') {
    const { reference, referenceList } = require('./starters')
    if (!args.kind) return { success: true, references: referenceList() }
    say('Смотрю разбор: ' + args.kind)
    return reference(args.kind)
  }

  if (name === 'dc_screenshot') {
    const component = await store.read(designId, args.path)
    if (!shoot) return { success: false, error: 'Снимок недоступен в этой среде.' }
    say('Смотрю на страницу: ' + component.name)
    return shoot(component.name, args.view || 'desktop')
  }

  if (name === 'dc_measure') {
    const component = await store.read(designId, args.path)
    if (!measure) return { success: false, error: 'Среда замера недоступна' }
    say('Измеряю отрисованную страницу')
    return measure(component.name)
  }

  if (name === 'dc_refs') {
    const refs = await store.listRefs(designId)
    return {
      success: true,
      refs,
      // Как этим пользоваться, сказано здесь же: список имён без правила
      // употребления модель обычно игнорирует.
      hint: refs.length
        ? 'Ссылайся на файлы из макета относительным путём: refs/<имя>. Например <img src="refs/logo.png">. Текстовые открывай через dc_read_ref.'
        : 'Пользователь ничего не приложил.'
    }
  }

  if (name === 'dc_read_ref') {
    const found = await store.readRef(designId, args.path)
    return {
      success: true,
      path: found.name,
      text: found.text,
      truncated: found.truncated,
      bytes: found.bytes
    }
  }

  if (name === 'dc_list') {
    const files = await store.list(designId)
    return { success: true, components: files }
  }

  if (name === 'dc_read') {
    const found = await store.read(designId, args.path)
    return {
      success: true,
      path: found.name,
      b_dc_html: found.template,
      c_dc_js: found.logic,
      d_props_json: found.props
    }
  }

  if (name === 'dc_set_entry') {
    const result = await store.setEntry(designId, args.path)
    say(`Основная страница: ${result.name}`)
    return { success: true, path: result.name }
  }

  if (name === 'dc_write') {
    const template = String(args.b_dc_html ?? '')
    if (!template.trim()) throw new Error('Пустая разметка: компонент должен что-то рисовать.')
    // The wrapper is assembled here, so a model that pasted it in anyway would
    // otherwise produce a document nested inside a document.
    if (/<x-dc[\s>]/i.test(template) || /<!DOCTYPE/i.test(template)) {
      throw new Error('Передавай только содержимое между <x-dc> и </x-dc>: обёртку документа добавляет среда.')
    }
    if (args.d_props_json) {
      try { JSON.parse(args.d_props_json) } catch { throw new Error('d_props_json не разбирается как JSON.') }
    }
    const written = await store.write(designId, args.path, {
      template,
      logic: String(args.c_dc_js ?? ''),
      props: String(args.d_props_json ?? '')
    })
    say(`Записан компонент: ${written.name}`)
    return { success: true, path: written.name }
  }

  if (name === 'dc_html_str_replace' || name === 'dc_js_str_replace') {
    const part = name === 'dc_html_str_replace' ? 'template' : 'logic'
    const result = await store.replace(designId, args.path, part,
      String(args.old_str ?? ''), String(args.new_str ?? ''))
    say(`Правка в ${result.name}`)
    return { success: true, path: result.name, replaced: result.replaced }
  }

  if (name === 'dc_set_props') {
    const props = String(args.d_props_json ?? '')
    if (props.trim()) {
      try { JSON.parse(props) } catch { throw new Error('d_props_json не разбирается как JSON.') }
    }
    const result = await store.setProps(designId, args.path, props)
    return { success: true, path: result.name }
  }

  if (name === 'dc_delete') {
    const allowed = await confirm?.('Удалить компонент', String(args.path || ''))
    if (allowed === false) {
      return { success: false, denied: true, message: 'Удаление отклонено пользователем.' }
    }
    const removed = await store.remove(designId, args.path)
    say(`Удалён компонент: ${removed.name}`)
    return { success: true, path: removed.name }
  }

  if (name === 'dc_comments') {
    const open = (comments || []).filter(c => !c.resolved)
    return {
      success: true,
      comments: open.map(c => ({
        anchor: c.anchor,
        element: c.element || '',
        component: c.component || '',
        text: c.text || ''
      }))
    }
  }

  if (name === 'dc_resolve_comment') {
    const anchor = String(args.anchor || '')
    const target = (comments || []).find(c => c.anchor === anchor)
    if (!target) throw new Error(`Замечание с якорем «${anchor}» не найдено.`)
    target.resolved = true
    return { success: true, anchor }
  }

  throw new Error(`Неизвестный инструмент дизайна: ${name}`)
}

module.exports = { designToolSchemas, executeDesignTool, DESIGN_TOOL_NAMES }
