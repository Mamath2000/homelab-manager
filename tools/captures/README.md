# Captures d'écran de la documentation

Les images de `docs/img/guide/` sont produites sans base ni machine réelle : `server.mjs` sert `web/dist` avec des données fictives (un homelab de démonstration), `shoot.cjs` pilote Chromium (Playwright).

```sh
cd web && npm ci && npm run build && cd ..
cd tools/captures && node shoot.cjs            # toutes les captures
node shoot.cjs sauvegardes roles              # certaines seulement
```

Le port 4173 doit être libre. Les captures sont en 1680 × 1050, échelle 1,5. Pour changer ce qu'on voit, modifier les données de `server.mjs` (typées à la main d'après `web/src/lib/api.ts`).
