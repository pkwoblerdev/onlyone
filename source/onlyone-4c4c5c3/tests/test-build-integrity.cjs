// Сквозной набор «без сбоев», часть 1 (план, 9.7): целостность сборки по исходникам.
//
// Поломки при сборке до сих пор находились уже в готовой установке: 27.09 из общей
// node_modules пропали пакеты (`Cannot find module 'conf'`), 1.1.17 вышла без
// пакетов, которые нужны в рантайме. Здесь — быстрая проверка до сборки, без окна:
// всё, что код подключает, на месте и объявлено там, где его подхватит упаковщик.
const fs = require('node:fs')
const path = require('node:path')
const { builtinModules } = require('node:module')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const pkg = JSON.parse(read('package.json'))
let failed = 0
const check = (name, pass, detail) => {
  if (!pass) failed++
  console.log(`${pass ? 'ok    ' : 'ПРОВАЛ'} ${name}${!pass && detail ? ' — ' + detail : ''}`)
}

function jsFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) { if (entry.name !== 'vendor') out.push(...jsFiles(rel)) } else if (entry.name.endsWith('.js')) out.push(rel)
  }
  return out
}

// --- 1. Пакеты: подключены в коде → объявлены в dependencies → лежат на диске ---
const builtins = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name), 'electron'])
const bare = new Map() // пакет → первый файл, где подключён
for (const file of [...jsFiles('src/main'), ...jsFiles('src/preload')]) {
  for (const [, spec] of read(file).matchAll(/\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (spec.startsWith('.') || spec.startsWith('/') || builtins.has(spec)) continue
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (!bare.has(name)) bare.set(name, file)
  }
}
const undeclared = [...bare].filter(([name]) => !(pkg.dependencies || {})[name]).map(([name, file]) => `${name} (${file})`)
check('всё, что главный процесс подключает, объявлено в dependencies (devDependencies в сборку не идут)',
  undeclared.length === 0, undeclared.join(', '))

const nodeModules = path.join(root, 'node_modules')
const onDisk = name => fs.existsSync(path.join(nodeModules, name, 'package.json'))
const absent = [...bare.keys()].filter(name => !onDisk(name))
check('каждый подключаемый пакет лежит в node_modules', absent.length === 0, absent.join(', '))

// Транзитивные зависимости объявленных пакетов: упаковщик берёт их с диска, и
// отсутствие любого в дереве — «missing production dependency» уже на сборке.
const missingTree = new Set()
const seen = new Set()
const walk = (name, from) => {
  if (seen.has(from + '>' + name)) return
  seen.add(from + '>' + name)
  // Ищем вверх по вложенным node_modules, как это делает Node.
  let dir = from
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json')
    if (fs.existsSync(candidate)) {
      const meta = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      for (const dep of Object.keys(meta.dependencies || {})) walk(dep, path.dirname(candidate))
      return
    }
    const up = path.dirname(dir)
    if (up === dir || dir.length <= root.length) break
    dir = up
  }
  if (fs.existsSync(path.join(root, 'node_modules', name, 'package.json'))) {
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'))
    for (const dep of Object.keys(meta.dependencies || {})) walk(dep, path.join(root, 'node_modules', name))
    return
  }
  missingTree.add(name)
}
for (const name of Object.keys(pkg.dependencies || {})) walk(name, root)
check('дерево зависимостей production целиком на диске', missingTree.size === 0, [...missingTree].slice(0, 8).join(', '))

// --- 2. Файлы, на которые ссылается код ---
const missingRel = []
for (const file of [...jsFiles('src/main'), ...jsFiles('src/preload')]) {
  for (const [, spec] of read(file).matchAll(/\brequire\(\s*['"](\.[^'"]*)['"]\s*\)/g)) {
    const target = path.resolve(root, path.dirname(file), spec)
    if (!['', '.js', '.json', '.cjs', '/index.js'].some(ext => fs.existsSync(target + ext) && fs.statSync(target + ext).isFile())) missingRel.push(`${file} → ${spec}`)
  }
}
check('каждый относительный require главного процесса указывает на существующий файл', missingRel.length === 0, missingRel.slice(0, 4).join('; '))

const html = read('src/renderer/index.html')
const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"#?]+)"/g)].map(m => m[1]).filter(ref => !/^(https?:|data:|file:)/.test(ref))
const missingRefs = refs.filter(ref => !fs.existsSync(path.join(root, 'src/renderer', ref)))
check('каждый скрипт и стиль из index.html лежит на диске', missingRefs.length === 0, missingRefs.join(', '))

const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"#?]+)"/g)].map(m => m[1])
check('app.js подключён последним из своих модулей (модули должны успеть объявить себя)',
  scripts.filter(src => !src.startsWith('vendor/')).slice(-1)[0] === 'app.js', scripts.slice(-3).join(', '))

const packagedFiles = require(path.join(root, 'electron-builder.config.cjs')).files
check('plugin runtime files included in package', packagedFiles.includes('tools/plugin/**/*'))

// --- 3. Сама упаковка ---
const builder = read('electron-builder.config.cjs')
check('упаковщик проверяет production-зависимости после упаковки (afterPack)',
  /afterPack:\s*require\(['"]\.\/scripts\/verify-packaged-runtime-dependencies\.cjs['"]\)/.test(builder))
// Фьюзы (разбор REA 25.10): без них готовый exe принимает --inspect и NODE_OPTIONS,
// а app.asar можно подменить. runAsNode нужен «своим инструментам» — см. конфиг.
const fuses = require(path.join(root, 'electron-builder.config.cjs')).electronFuses || {}
const wantFuses = { runAsNode: true, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true }
const wrongFuses = Object.entries(wantFuses).filter(([name, value]) => fuses[name] !== value).map(([name]) => name)
check('фьюзы Electron закрыты в конфиге сборки', wrongFuses.length === 0, wrongFuses.join(', '))
check('main в package.json указывает на существующий файл', fs.existsSync(path.join(root, pkg.main)), pkg.main)
const lock = JSON.parse(read('package-lock.json'))
check('версия в package-lock совпадает с package.json', lock.version === pkg.version, `${lock.version} ≠ ${pkg.version}`)

// --- 4. Каждое звено набора существует ---
const chains = ['pretest', 'test', 'posttest'].flatMap(name => [...String(pkg.scripts[name] || '').matchAll(/node (tests[\\/][\w.\-]+\.(?:cjs|js))/g)].map(m => m[1]))
const absentTests = chains.filter(file => !fs.existsSync(path.join(root, file)))
check('каждое звено pretest/test/posttest существует на диске', absentTests.length === 0, absentTests.slice(0, 4).join(', '))

console.log(JSON.stringify({ ok: failed === 0, failed, packages: bare.size }))
process.exit(failed ? 1 : 0)
