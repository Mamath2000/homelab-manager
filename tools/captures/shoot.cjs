const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const OUT = process.env.OUT || require('node:path').resolve(__dirname, '../../docs/img/guide');
const only = process.argv.slice(2);

(async () => {
  const srv = spawn('node', [__dirname + '/server.mjs'], { env: { ...process.env, DIST: require('node:path').resolve(__dirname, '../../web/dist'), DEMO_PORT: '4173' }, stdio: ['ignore', 'inherit', 'inherit'] });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 1.5, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text().slice(0, 200)); });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message.slice(0, 200)));
  const base = 'http://localhost:4173';
  const shots = {
    dashboard: async () => { await page.goto(base + '/'); await page.waitForTimeout(1500); },
    'hote-detail': async () => { await page.goto(base + '/hosts/h2'); await page.waitForTimeout(1800); },
    sauvegardes: async () => { await page.goto(base + '/backups'); await page.waitForTimeout(1800); },
    roles: async () => { await page.goto(base + '/settings?tab=roles'); await page.waitForTimeout(1500); },
    sondes: async () => { await page.goto(base + '/probes'); await page.waitForTimeout(1500); },
    'ajouter-hote': async () => {
      await page.goto(base + '/hosts'); await page.waitForTimeout(1200);
      await page.getByRole('button', { name: /Ajouter un hôte/ }).first().click(); await page.waitForTimeout(600);
      await page.getByPlaceholder(/pihole/).fill('docker-02');
      await page.locator('select').first().selectOption({ label: 'Maison' });
      await page.getByRole('button', { name: /infra/ }).first().click();
      await page.getByRole('button', { name: /Générer le script/ }).click(); await page.waitForTimeout(1000);
    },
  };
  for (const [name, fn] of Object.entries(shots)) {
    if (only.length && !only.includes(name)) continue;
    await fn();
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.error('[shot]', name);
  }
  await browser.close();
  srv.kill();
})().catch((e) => { console.error(e); process.exit(1); });
