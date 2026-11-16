window.OnlyoneUI.mount(document);
document.querySelector('#theme').addEventListener('click', event => {
  const light = document.documentElement.dataset.theme !== 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  event.currentTarget.setAttribute('aria-pressed', String(light));
  event.currentTarget.textContent = light ? 'Тёмная тема' : 'Светлая тема';
});
