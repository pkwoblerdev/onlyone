// Set the browser's real media preference; never inject CSS that makes the test pass.
const { app } = require('electron');
app.on('browser-window-created', (_, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name:'prefers-reduced-motion', value:'reduce' }]
      });
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require('../src/main/main.js');
