// Правила для запуска команд агентом. Проверяется настоящий модуль, а не
// пересказ: условие — «никакой угрозы самому приложению».
const assert = require('node:assert/strict')
const { checkCommand } = require('../src/main/command-guard')

const failures = []
function test(name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}

const ENV = { APPDATA: 'C:/Users/user/APPDATA', LOCALAPPDATA: 'C:/Users/user/LOCALAPPDATA', USERPROFILE: 'C:/Users/user' }
const PROTECTED = ['C:/Users/user/APPDATA/1code', 'C:/Users/user/LOCALAPPDATA/1code-updater', 'D:/onlyone']
const NAMES = ['onlyone.exe', 'onlyone']
const WORK = 'D:/projects/app'

const verdict = command => checkCommand({ command, cwd: WORK, protectedRoots: PROTECTED, appNames: NAMES, pid: 4242, env: ENV })
const allows = command => assert.equal(verdict(command).ok, true, `нельзя, хотя можно: ${verdict(command).reason}`)
const denies = (command, about) => {
  const result = verdict(command)
  assert.equal(result.ok, false, `пропустили опасное: ${command}`)
  if (about) assert.ok(result.reason.toLowerCase().includes(about.toLowerCase()), `причина не про «${about}»: ${result.reason}`)
}

test('обычную работу в папке проекта не трогает', () => {
  allows('npm test')
  allows('npm run build:win')
  allows('git status')
  allows('node tools/make-icons.js src out/icon.png')
  allows('dir src\\main')
  allows('type README.md')
})

test('профиль и установка недоступны на запись', () => {
  denies('del /q %APPDATA%\\1code\\1code-settings.json', 'onlyone')
  denies('Remove-Item $env:APPDATA\\1code\\data\\conversations.json')
  denies('copy .env C:\\Users\\user\\APPDATA\\1code\\underwrite.txt')
  denies('echo x > "C:/Users/user/APPDATA/1code/evil.txt"')
  denies('rd /s /q D:\\onlyone', 'массов')
})

test('чтение профиля остаётся разрешённым', () => {
  allows('type %APPDATA%\\1code\\logs\\latency.log')
  allows('Get-Content C:/Users/user/APPDATA/1code/logs/latency.log')
})

test('массовое удаление отклоняется всегда', () => {
  denies('rm -rf .', 'массов')
  denies('del /s /q *.tmp', 'массов')
  denies('find . -name "*.log" -delete', 'массов')
  denies('git clean -fdx', 'массов')
  allows('git clean -n')
})

test('приложение и машина неприкосновенны', () => {
  denies('taskkill /IM onlyone.exe /F', 'onlyone')
  denies('taskkill /PID 4242 /F', 'onlyone')
  denies('Stop-Process -Name onlyone -Force', 'onlyone')
  denies('shutdown /s /t 0', 'перезагрузк')
  allows('taskkill /IM some-other-tool.exe /F')
})

test('команда не запускается из папки приложения', () => {
  const result = checkCommand({ command: 'npm test', cwd: 'C:/Users/user/APPDATA/1code', protectedRoots: PROTECTED, appNames: NAMES, env: ENV })
  assert.equal(result.ok, false)
  assert.ok(/onlyone/i.test(result.reason), result.reason)
})

test('пустая команда не запускается', () => {
  assert.equal(verdict('   ').ok, false)
})

if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
