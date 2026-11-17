// Сводка аудита: из raw.json — что и где расходится.
const fs = require('fs')
const path = require('path')
const outDir = path.join(require('os').tmpdir(), 'onlyone-design-audit')
const raw = JSON.parse(fs.readFileSync(path.join(outDir, 'raw.json'), 'utf8'))

const all = { texts: [], icons: [], controls: [], radii: [], shadows: [], titles: [], glyphs: [], emoji: [] }
for (const [state, entry] of Object.entries(raw)) {
  if (!entry.metrics) continue
  for (const key of Object.keys(all)) for (const row of entry.metrics[key] || []) all[key].push({ state, ...row })
}

const group = (rows, keyOf) => {
  const map = new Map()
  for (const row of rows) {
    const key = keyOf(row)
    if (!map.has(key)) map.set(key, { key, rows: [], zones: new Set(), samples: new Set() })
    const g = map.get(key)
    g.rows.push(row); g.zones.add(row.zone)
    if (row.sample && g.samples.size < 3) g.samples.add(row.sample)
  }
  return [...map.values()].sort((a, b) => b.rows.length - a.rows.length)
}
// Один и тот же элемент попадает в несколько прогонов — считаем уникальные по зоне, классу и тексту.
const uniq = (rows, keyOf) => {
  const seen = new Set()
  return rows.filter(row => { const k = keyOf(row); if (seen.has(k)) return false; seen.add(k); return true })
}
const texts = uniq(all.texts, r => [r.zone, r.cls, r.sample, r.size, r.weight].join('|'))
const lines = []
const out = s => lines.push(s)

out('# Аудит дизайна onlyone\n')
out('Состояний окна: ' + Object.keys(raw).length + '. Уникальных текстовых элементов: ' + texts.length + '.\n')

const fam = group(texts, r => r.family)
out('## Семейства шрифтов')
for (const g of fam) out(`- ${g.key}: ${g.rows.length} элементов · зоны: ${[...g.zones].join(', ')}`)

const sizes = [...new Set(texts.map(r => r.size))].sort((a, b) => a - b)
const weights = [...new Set(texts.map(r => r.weight))].sort()
out('\n## Размеры текста: ' + sizes.length + ' разных')
out(sizes.map(s => s + 'px').join(', '))
out('\n## Насыщенность: ' + weights.join(', '))
const colors = group(texts, r => r.color)
out('\n## Цвета текста: ' + colors.length + ' разных')
for (const g of colors.slice(0, 25)) out(`- ${g.key}: ${g.rows.length} · ${[...g.zones].slice(0, 6).join(', ')}`)

out('\n## Начертания (семейство · размер · насыщенность · межстрочный) по зонам')
const styles = group(texts, r => `${r.family} ${r.size}/${r.lh} w${r.weight}${r.tt !== 'none' ? ' ' + r.tt : ''}${r.ls !== 'normal' ? ' ls' + r.ls : ''}`)
out('Всего разных начертаний: ' + styles.length)
const ref = new Set(texts.filter(r => r.zone === 'боковая панель').map(r => `${r.family} ${r.size} w${r.weight}`))
out('\nЭталон — боковая панель: ' + [...ref].join(' | '))
for (const g of styles) {
  const inRef = ref.has(`${g.rows[0].family} ${g.rows[0].size} w${g.rows[0].weight}`)
  out(`- ${inRef ? '' : '✗ '}${g.key} — ${g.rows.length} · ${[...g.zones].join(', ')} · «${[...g.samples].join('» «')}»`)
}

out('\n## По зонам: сколько разных начертаний')
const zones = group(texts, r => r.zone)
for (const z of zones) {
  const inZone = new Set(z.rows.map(r => `${r.family} ${r.size} w${r.weight}`))
  const foreign = [...inZone].filter(k => !ref.has(k))
  out(`- ${z.key}: ${inZone.size} начертаний, вне эталона ${foreign.length}: ${foreign.join(' | ')}`)
}

const icons = uniq(all.icons, r => [r.zone, r.cls, r.parent, r.w, r.h, r.stroke].join('|'))
out('\n## Значки: ' + icons.length + ' уникальных')
for (const g of group(icons, r => `${r.w}×${r.h} линия ${r.stroke} заливка ${r.fill}`)) out(`- ${g.key}: ${g.rows.length} · ${[...g.zones].join(', ')}`)

const controls = uniq(all.controls, r => [r.zone, r.cls, r.label].join('|'))
out('\n## Кнопки и поля: высоты')
for (const g of group(controls, r => r.tag + ' h' + r.h)) out(`- ${g.key}: ${g.rows.length} · ${[...g.zones].slice(0, 8).join(', ')}`)
out('\n## Кнопки и поля: радиусы')
for (const g of group(controls, r => r.radius)) out(`- ${g.key}: ${g.rows.length} · ${[...g.zones].slice(0, 8).join(', ')}`)

const radii = uniq(all.radii, r => [r.zone, r.cls, r.radius].join('|'))
out('\n## Радиусы скруглений (всё с фоном или рамкой): ' + new Set(radii.map(r => r.radius)).size + ' разных')
for (const g of group(radii, r => r.radius)) out(`- ${g.key}: ${g.rows.length} · ${[...g.zones].slice(0, 8).join(', ')}`)

const shadows = uniq(all.shadows, r => [r.zone, r.cls, r.shadow].join('|'))
out('\n## Тени: ' + new Set(shadows.map(r => r.shadow)).size + ' разных')
for (const g of group(shadows, r => r.shadow)) out(`- ${g.key}: ${g.rows.length} · ${[...g.zones].slice(0, 6).join(', ')}`)

const titles = uniq(all.titles, r => [r.zone, r.title].join('|'))
out('\n## Системные подсказки (title): ' + titles.length + ' видимых')
for (const g of group(titles, r => r.zone)) out(`- ${g.key}: ${g.rows.length} — ${g.rows.slice(0, 5).map(r => '«' + r.title + '»').join(', ')}`)

const glyphs = uniq(all.glyphs, r => [r.zone, r.text].join('|'))
out('\n## Символы вместо значков: ' + glyphs.length)
for (const r of glyphs) out(`- ${r.zone}: «${r.text}» · ${r.family} ${r.size}px`)

const emoji = uniq(all.emoji, r => [r.zone, r.text].join('|'))
out('\n## Эмодзи: ' + emoji.length)
for (const r of emoji) out(`- ${r.zone}: «${r.text}» · ${r.size}px · ${r.family}`)

out('\n## Время')
for (const [state, entry] of Object.entries(raw)) if (entry.timings && Object.keys(entry.timings).length) out(`- ${state}: ${JSON.stringify(entry.timings)}`)

fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'))
console.log(lines.join('\n'))
