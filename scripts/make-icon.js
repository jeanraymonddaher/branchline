// Renders build/icon.png (1024px) from an inline SVG. Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3c5"/><stop offset="0.5" stop-color="#2f6bff"/><stop offset="1" stop-color="#8b2be2"/></linearGradient>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>
<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)"/>
<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#s)"/>
<g fill="none" stroke="#fff" stroke-width="60" stroke-linecap="round" stroke-linejoin="round">
<path d="M372 290V734"/>
<path d="M372 290H520a111 111 0 0 1 0 222H372"/>
<path d="M372 512H560a111 111 0 0 1 0 222H372"/>
</g>
<g fill="#fff"><circle cx="372" cy="290" r="62"/><circle cx="372" cy="512" r="62"/><circle cx="372" cy="734" r="62"/></g>
<circle cx="372" cy="290" r="26" fill="#22b8c9"/><circle cx="372" cy="512" r="26" fill="#2f6bff"/><circle cx="372" cy="734" r="26" fill="#6a3fe8"/>
</svg>`;
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent">${svg}</body>`));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
