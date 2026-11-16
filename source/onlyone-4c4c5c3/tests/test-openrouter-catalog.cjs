async function main() {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'HTTP-Referer': 'https://1code.local', 'X-OpenRouter-Title': '1code' }
  })
  if (!response.ok) throw new Error(`OpenRouter returned ${response.status}`)
  const payload = await response.json()
  const models = Array.isArray(payload?.data) ? payload.data : []
  // Ox Alpha turned out to be a GLM 5.3 preview and left the catalogue, so the
  // default moved to the strongest free model that still calls tools.
  const fallback = models.find(model => model.id === 'dots-studio/dots-3-note-preview:free')
  if (!models.length || !fallback) throw new Error('Каталог пуст или в нём нет minimax/minimax-m3:free')
  if (!(fallback.supported_parameters || []).includes('tools')) {
    throw new Error('У модели по умолчанию пропала поддержка инструментов')
  }
  console.log(JSON.stringify({ ok: true, count: models.length, default: fallback.name || fallback.id }))
}
main().catch(error => { console.error(error); process.exit(1) })
