---
title: Configuration
description: Paramètres de l'application et variables d'environnement du hub
sidebar_position: 2
---

# Configuration

## Paramètres de l'application

Réglés dans l'interface, **Paramètres > Agent**, et stockés en base :

| Paramètre | Défaut | Rôle |
|---|---|---|
| URL du hub | adresse utilisée dans le navigateur | Adresse de l'interface telle que les hôtes la joignent : liens « configuration » dans Home Assistant ; son nom d'hôte sert aussi aux agents |
| Port TLS des agents | `3443` (`AGENT_TLS_PORT`) | Port **publié** du hub pour les agents. Les agents se connectent à `https://<nom d'hôte de l'URL du hub>:<port>`. Un agent garde l'adresse de son installation : après un changement, relancer la commande de mise à jour sur l'hôte |
| Vérification automatique des mises à jour | `12` h | Fréquence de l'`apt-get update` lancé sur les hôtes en ligne ; `0` désactive |
| Mise à jour automatique des agents | activée | Un agent d'une autre version que celle du hub se met à jour seul |

### Adresse des agents

Dans **URL du hub**, saisir l'adresse de l'interface telle que les hôtes la joignent, en `http://` ou en `https://` : peu importe pour les agents. Le hub n'en garde que le **nom d'hôte** et donne aux agents `https://<nom d'hôte>:<Port TLS des agents>`. Le protocole et le port saisis ne servent qu'aux liens de Home Assistant.

| URL du hub saisie | Adresse donnée aux agents |
|---|---|
| `http://192.168.1.10:3000` | `https://192.168.1.10:3443` |
| `https://hm.lan` (reverse proxy) | `https://hm.lan:3443` |
| vide | nom d'hôte utilisé dans le navigateur, port `3443` |

- Le nom d'hôte doit mener à la machine où le port des agents du hub est publié. Si `hm.lan` pointe vers un reverse proxy installé sur une autre machine, saisir plutôt l'IP du hub (`http://192.168.1.10:3000`), ou faire passer le port `3443` par le proxy en TCP, sans terminaison TLS (voir [Derrière un reverse proxy](#derrière-un-reverse-proxy)).
- Pour vérifier : la ligne **Adresse des agents** de **Paramètres > Agent** affiche l'adresse exacte utilisée dans les commandes d'installation.
- Un agent garde l'adresse de son installation : après un changement, relancer sur l'hôte la commande de mise à jour manuelle (**Paramètres > Agent**).

## Variables d'environnement

Fixées dans `compose.yml` pour le déploiement, et par le Makefile en local (`make start PORT=4000 LOG=debug MONGO_URL=…`). Une variable vide équivaut à une variable absente.

| Variable | Défaut | Rôle |
|---|---|---|
| `MONGO_URL` | `mongodb://localhost:27017/homelab` | Base MongoDB (`mongodb://mongo:27017/homelab` dans `compose.yml`) |
| `PORT` | `3000` | Port d'écoute de l'interface et de l'API ; en Docker le port publié se choisit dans `ports:` |
| `AGENT_TLS_PORT` | `3443` | Port d'écoute TLS des agents (script d'installation, binaires, enrôlement, WebSocket) |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` (`LOG=` avec le Makefile) |
| `LOG_FILE` | *(vide)* | Chemin d'un fichier où les journaux (JSON) sont aussi écrits, en plus de la sortie standard ; vide : sortie standard seule. Le Makefile le règle sur `logs/hub.log` en local (`make logs` le suit), `compose.yml` ne le définit pas |
| `TZ` | `Europe/Paris` | fuseau du hub : fuseau proposé par défaut pour les [sauvegardes de répertoires](sauvegardes.md#sauvegardes-de-répertoires) (chaque job garde le sien) |
| `SESSION_DAYS` | `30` | Durée des sessions de l'interface |
| `COOKIE_SECURE` | *(automatique)* | Absente : cookie de session `Secure` quand la requête arrive en HTTPS (port HTTPS, ou proxy de confiance). `true` : toujours `Secure` (aucune session possible en HTTP). `false` : jamais |
| `TRUST_PROXY` | `false` | Adresses des reverse proxys (`192.168.1.20`, ou liste `10.0.0.5,192.168.1.0/24`) dont les en-têtes `X-Forwarded-*` sont crus. Une requête portant ces en-têtes depuis une autre adresse est **refusée** (`400 untrusted_proxy`, comme Home Assistant avec `trusted_proxies`) : un proxy oublié se voit tout de suite. `true` croit **tout** client : sûr seulement si le port n'est joignable que par le proxy |
| `HTTPS_PORT` | *(vide)* | Port HTTPS de l'interface, en plus du port HTTP (`4443` en Docker) ; vide : désactivé. Voir [HTTPS natif](#https-natif) |
| `HTTPS_PUBLIC_PORT` | `HTTPS_PORT` | Port publié du HTTPS, s'il diffère (`8443:4443`) : le port HTTP y redirige |
| `HTTPS_CERT_FILE` / `HTTPS_KEY_FILE` | *(vide)* | Certificat et clé (PEM) à servir, montés en lecture seule ; vides : certificat émis par le hub |
| `HTTPS_SAN` | *(vide)* | Noms et IP ajoutés au certificat émis (`hub.lan,192.168.1.10`) |
| `HTTP_MODE` | `redirect` | Port HTTP quand `HTTPS_PORT` est réglé : `redirect` (pages redirigées, connexion et clés d'API refusées en HTTP) ou `local` (HTTP sur `127.0.0.1` seulement) |
| `FEATURE_BACKUP_NEXTCLOUD_AIO` | `false` | `true` affiche le [plugin Nextcloud AIO](sauvegardes.md#plugin-nextcloud-aio) des sauvegardes |
| `FEATURE_STANDARDISATION` | `false` | `true` affiche et active la [standardisation](standardisation.md) des hôtes |

## Derrière un reverse proxy

Le hub n'a pas besoin d'être exposé, mais il peut passer derrière un reverse proxy local (Nginx Proxy Manager, Traefik…) :

- ne pas bufferiser `/api/events` (flux temps réel) ;
- `TRUST_PROXY=<adresse du proxy>` : obligatoire dès que le proxy envoie les en-têtes `X-Forwarded-*` (la plupart le font par défaut, NPM compris), sinon le hub répond `400 untrusted_proxy` avec l'adresse à déclarer, et la raison est écrite dans ses journaux. Le cookie de session devient alors `Secure` tout seul quand le proxy sert en HTTPS. `COOKIE_SECURE=true` le force, et interdit en plus toute session en HTTP direct ;
- ne publier le port de l'interface que vers le proxy : `127.0.0.1:3000:3000` (proxy sur le même hôte), ou `<IP>:3000:3000` et un pare-feu (proxy sur une autre machine). Un proxy dans le même compose n'a pas besoin de `ports:` ;
- **proxy sur une autre machine** : le trajet proxy → hub passe en clair sur le réseau. Activer le [HTTPS natif](#https-natif) et faire pointer le proxy en `https://` ; les admins voient un bandeau tant que ce trajet est en clair ;
- HSTS : à activer dans le proxy (le hub ne l'envoie pas : sur un certificat qu'il émet lui-même, il rendrait l'interface inaccessible) ;
- le port des agents (`3443`) ne passe **pas** par un reverse proxy qui termine le TLS : il casserait l'épinglage et l'authentification des agents par certificat. Le publier directement, ou via un proxy TCP (*passthrough*) ;
- **URL du hub** : son nom d'hôte doit mener à la machine où le port des agents est publié.

## HTTPS natif

`HTTPS_PORT` ouvre un second port, en HTTPS, à côté du port HTTP (même interface, mêmes sessions). Exemple dans `compose.yml` :

```yaml
    ports:
      - "3000:3000"
      - "3443:3443"
      - "4443:4443"
    environment:
      HTTPS_PORT: 4443
      # HTTPS_SAN: hub.lan,192.168.1.10
```

- **Certificat** : sans `HTTPS_CERT_FILE`, le hub en émet un avec sa propre autorité, pour `homelab-manager`, `localhost`, `127.0.0.1`, le nom de l'URL du hub (Paramètres > Agent) et `HTTPS_SAN`. Il est distinct de celui du port des agents (les agents ne sont jamais touchés), vaut 397 jours et se renouvelle seul 30 jours avant la fin, ou quand les noms changent. Son empreinte est dans les journaux du hub (`https: UI listening`).
- **Navigateur en direct** : il affiche un avertissement ; accepter l'exception **pour ce certificat**, après avoir comparé l'empreinte. **Ne pas importer l'autorité du hub** dans le navigateur ou le système : elle n'a pas de contrainte de nom, un hub compromis pourrait alors intercepter n'importe quel site depuis ce poste.
- **Reverse proxy** : le faire pointer sur `https://<hub>:4443` en vérifiant le certificat avec l'autorité du hub et le nom `homelab-manager` (l'IP du hub peut changer sans réémettre). L'autorité se télécharge sur `https://<hub>:3443/agent/ca.pem` ; vérifier son empreinte avec celle de Paramètres > Agent.
  - Nginx / Nginx Proxy Manager (onglet *Advanced*) : `proxy_ssl_trusted_certificate /data/hm-ca.pem; proxy_ssl_verify on; proxy_ssl_name homelab-manager; proxy_ssl_server_name on;`, schéma `https`. Sans ces lignes, NPM chiffre sans vérifier : le trajet est protégé de l'écoute, pas d'une interception active.
  - Caddy :

    ```
    reverse_proxy https://hub:4443 {
      transport http {
        tls_trusted_ca_certs /etc/caddy/hm-ca.pem
        tls_server_name homelab-manager
      }
    }
    ```
  - Traefik : un `serversTransport` avec `rootCAs` (l'autorité) et `serverName: homelab-manager`.
- **Port HTTP** (`HTTP_MODE`) : `redirect` (défaut) renvoie les pages vers le HTTPS (`308`) et refuse en HTTP la connexion et les clés d'API (`403 https_required`), sauf depuis `127.0.0.1` (sonde de santé Docker), pour `/api/health`, et pour un proxy de confiance (`TRUST_PROXY`) qui a reçu la requête en HTTPS. `local` n'écoute plus en HTTP que sur `127.0.0.1`. Les intégrations qui appellent l'API en HTTP (Homepage…) sont à passer en `https://`.
- Les sessions ouvertes en HTTP avant l'activation restent valides jusqu'à leur expiration (`SESSION_DAYS`) ; se déconnecter puis se reconnecter en HTTPS pour en ouvrir une protégée.

## Données

| Collection MongoDB | Contenu |
|---|---|
| `settings` | paramètres de l'application (agents, Home Assistant, brokers MQTT des sondes) et autorité de certification du hub (document `pki`, clés privées comprises), certificat du port HTTPS de l'interface (document `uiTls`) |
| `hosts` | hôtes, empreinte du certificat de l'agent, hash du code d'installation en attente, dernier état système et APT |
| `probes` | sondes de service ([Sondes](sondes.md)) : cible, réglages et état courant, sans historique de mesures ; supprimées avec leur hôte ou leur équipement |
| `equipments` | [équipements](equipements.md) suivis sans agent : type, site, adresse, amont, source et checks natifs remontés par la source |
| `equipmentAlerts` | frise des alertes des équipements, un document par équipement et par jour, gardé 40 jours |
| `jobs` | tâches et leurs sorties, supprimées après 90 jours |
| `users`, `sessions` | comptes utilisateurs et sessions |

Sauvegarder le dossier `mongo-data/` (hub arrêté) ou un `mongodump` suffit pour tout restaurer, y compris l'autorité de certification : les agents se reconnectent sans réinstallation. Sans clé maître, la sauvegarde contient les clés privées du hub en clair : elle est à protéger comme un secret. Avec une [clé maître](securite.md#base-de-données-et-secrets), elle ne livre aucun secret mais ne se restaure qu'avec cette clé : **sauvegarder `HM_MASTER_KEY` à part**, hors de la sauvegarde de la base.

`mongodump` et `mongorestore` sont inclus dans l'image `mongo` : rien à installer.

```bash
# dump (hub en marche)
docker exec homelab-manager-mongo mongodump --db homelab --archive --gzip > homelab.archive.gz
# restauration (écrase les collections existantes)
docker exec -i homelab-manager-mongo mongorestore --archive --gzip --drop < homelab.archive.gz
# base avec compte (MONGO_USERNAME / MONGO_PASSWORD du .env) : même chose, authentifié
docker exec homelab-manager-mongo sh -c 'mongodump -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db homelab --archive --gzip' > homelab.archive.gz
docker exec -i homelab-manager-mongo sh -c 'mongorestore -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip --drop' < homelab.archive.gz
```

Exemple de dump quotidien avec 7 jours de rétention (crontab root de l'hôte du hub) :

```bash
#!/bin/sh
set -eu
umask 077                      # le dump contient les clés privées du hub
DIR=/home/mamath/homelab-manager/backups
mkdir -p "$DIR"
OUT="$DIR/homelab-$(date +%F).archive.gz"
# base avec compte : sh -c 'mongodump -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin …'
docker exec homelab-manager-mongo mongodump --quiet --db homelab --archive --gzip > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
find "$DIR" -name "homelab-*.archive.gz" -mtime +7 -delete
```

```text
15 3 * * * /home/mamath/homelab-manager/mongo-backup.sh >> /var/log/homelab-manager-backup.log 2>&1
```
