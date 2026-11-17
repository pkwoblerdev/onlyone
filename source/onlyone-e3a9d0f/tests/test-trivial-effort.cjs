// Приветствие не должно стоить максимальной глубины рассуждений (11.10.2026): по умолчанию ползунок стоит на «max», и
// «Привет» гонял модель на полную. Осторожно: только короткие приветствия, благодарности и согласия; всё, где есть
// просьба, вопрос по делу или код, остаётся на выбранной человеком глубине.
const assert = require('node:assert/strict')
const { fastEffort, isTrivialMessage } = require('../src/main/fast-mode')

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

check('приветствия, благодарности и согласия — пустяк', () => {
  for (const text of ['Привет', 'привет!', 'Здравствуйте', 'Добрый день', 'Доброе утро!', 'спасибо', 'Спасибо большое!', 'ок', 'Окей.', 'понял', 'hi', 'Hello!', 'thanks', 'Thank you', 'пока'])
    assert.equal(isTrivialMessage(text), true, text)
})
check('любая просьба, вопрос или код — не пустяк', () => {
  for (const text of ['Привет, исправь баг в main.js', 'спасибо, а теперь сделай тесты', 'ок, запускай', 'Что такое замыкание?', 'привет как дела', 'Сделай страницу', '', '   ', 'hi there, build it', 'ok go ahead and run npm test'])
    assert.equal(isTrivialMessage(text), false, JSON.stringify(text))
})
check('пустяк идёт на low, выбранная глубина остальным сохраняется', () => {
  assert.equal(fastEffort({ reasoningEffort: 'max' }, 'Привет'), 'low')
  assert.equal(fastEffort({ reasoningEffort: 'high' }, 'Спасибо!'), 'low')
  assert.equal(fastEffort({ reasoningEffort: 'max' }, 'Исправь ошибку в main.js'), 'max')
  assert.equal(fastEffort({ reasoningEffort: 'medium' }, 'Объясни, как работает цикл'), 'medium')
  assert.equal(fastEffort({}, 'Сделай экран входа'), 'max', 'без выбора — прежний «max»')
})
check('дизайн и самодоработка не понижаются даже на «привет»', () => {
  assert.equal(fastEffort({ reasoningEffort: 'max', designId: 'd1' }, 'Привет'), 'max')
  assert.equal(fastEffort({ reasoningEffort: 'max', selfDevelopment: true }, 'Привет'), 'max')
})
check('Fast-режим по-прежнему отличает опасное от простого', () => {
  for (const task of ['rm -rf obsolete', 'git reset --hard']) assert.equal(fastEffort({ speedMode: 'fast' }, task), 'high', task)
  assert.equal(fastEffort({ speedMode: 'fast' }, 'Исправь опечатку'), 'low')
})
if (failed) process.exit(1)
console.log('Приветствие на low: проверки пройдены')
