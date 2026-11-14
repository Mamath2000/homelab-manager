---
title: Logs
description: Journaux des hôtes centralisés sur un serveur de logs (VictoriaLogs), envoyés en syslog par la standardisation et lus dans la page Logs
sidebar_position: 3.6
---

# Logs

Les journaux des hôtes sont centralisés sur un **serveur de logs** et lus dans la page **Logs** de Homelab Manager.

```
hôtes (rsyslog, posé par la standardisation) ──syslog TCP──► serveur de logs (VictoriaLogs)
navigateur ──► hub ──API HTTP de requête─────────────────────►
```

- **Les agents ne transportent aucun journal.** L'agent d'un hôte installe rsyslog et écrit sa configuration ; c'est rsyslog qui envoie, directement au serveur.
- Le serveur de logs est un [VictoriaLogs](https://docs.victoriametrics.com/victorialogs/) installé à la main sur un hôte, déclaré comme [rôle du hub](roles.md#serveur-de-logs).
- Le hub est le seul à interroger le serveur. L'entrée **Logs** du menu n'apparaît qu'avec un rôle **Serveur de logs**.

## Mise en place

1. Installer VictoriaLogs sur un hôte (ci-dessous).
2. **Paramètres › Rôles › Déclarer un rôle › Serveur de logs** : hôte, API (testée), délai d'alerte d'un hôte muet et destination des hôtes.
3. **Paramètres › Standardisation › Système** : cocher **Envoi des journaux**, choisir le serveur, enregistrer.
4. Appliquer la standardisation aux hôtes (fiche d'un hôte, ou sélection dans Hôtes). Voir [Standardisation](standardisation.md#envoi-des-journaux).

L'option de standardisation demande `FEATURE_STANDARDISATION=true` ([Configuration](configuration.md)). Le rôle et la page Logs n'en dépendent pas : un appareil configuré à la main pour envoyer en syslog au serveur est lisible aussi.

## Paramètres › Logs

L'onglet apparaît avec un rôle Serveur de logs (administrateurs). Pour chaque serveur, une carte par hôte qui lui envoie ses journaux :

| Couleur | État |
|---|---|
| vert | des journaux sont arrivés pendant le délai d'alerte du rôle (24 h s'il ne surveille pas les hôtes muets) |
| orange | installation en cours, ou écart de l'option : configuration à appliquer, ou serveur qui refuse la connexion sur le port envoyé (l'agent tente une connexion TCP à chaque vérification) |
| rouge | rien reçu pendant ce délai, ou l'agent ne peut pas appliquer l'option (agent à mettre à jour…) |

La carte indique aussi le site, « hors ligne », et comment l'hôte envoie : **standard** (valeur standard de la standardisation), **valeur propre**, ou **réglé à la main** (le serveur reçoit de lui sans que la standardisation l'y envoie). États relus toutes les 30 secondes, toutes les 5 secondes pendant une installation.

- **Ajouter des hôtes** : liste les hôtes qui n'envoient pas encore, à cocher (**Tout cocher** pour la liste filtrée) ; pour chaque hôte coché, l'option « Envoi des journaux » est réglée sur ce serveur (la valeur standard si c'est elle, sinon une valeur propre) et appliquée aussitôt : l'agent installe et configure rsyslog (une tâche par hôte). Un hôte en échec reste coché, avec la raison. Grisés : hôte hors ligne, agent à mettre à jour, hôte sans standardisation (Windows, HAOS, Unraid), standardisation désactivée sur le hub. Un hôte réglé à la main est proposé avec un avertissement : retirer son réglage manuel, sinon chaque ligne arrive en double.
- **Réappliquer** (carte en écart, orange ou rouge, hôte en ligne) : pousse de nouveau la configuration rsyslog, par exemple après un changement du port ou de l'adresse du serveur dans le rôle.
- **Corbeille** d'une carte : arrête l'envoi, après confirmation. L'option de l'hôte devient « aucun envoi » et l'agent retire son fichier (à la prochaine application si l'hôte est hors ligne). Pas de corbeille sur un hôte réglé à la main : son fichier n'est pas celui de l'agent.

Les émetteurs que le hub ne connaît pas sont listés sous les cartes.

## Installer VictoriaLogs

Exemple en Docker Compose, sur l'hôte qui portera le rôle :

```yaml
services:
  victorialogs:
    image: victoriametrics/victoria-logs:v1.53.0
    restart: unless-stopped
    # réseau de l'hôte : le serveur voit l'adresse réelle de chaque émetteur
    network_mode: host
    command:
      - -storageDataPath=/victoria-logs-data
      - -retentionPeriod=30d
      - -httpListenAddr=:9428
      - -syslog.listenAddr.tcp=:514
      - -syslog.useRemoteIP.tcp=true
    volumes:
      - ./data:/victoria-logs-data
```

| Réglage | Rôle |
|---|---|
| `-httpListenAddr` (9428) | API de requête, lue par le hub |
| `-syslog.listenAddr.tcp` (514) | réception des journaux des hôtes, en TCP ; un port sous 1024 demande que le processus soit root ou ait `CAP_NET_BIND_SERVICE` |
| `-retentionPeriod` | durée de conservation (7 jours par défaut) ; `-retention.maxDiskSpaceUsageBytes` borne aussi le disque |
| `-syslog.useRemoteIP.tcp` | garde l'adresse de l'émetteur de chaque journal (champ `remote_ip`) |

:::warning L'API de VictoriaLogs n'a pas de compte
Qui atteint le port 9428 lit tous les journaux, et peut en écrire. Le limiter au hub : pare-feu de l'hôte, ou écoute sur une adresse interne. Pour une authentification, placer devant un reverse proxy HTTPS : son compte se saisit dans le rôle (**Derrière un reverse proxy HTTPS**, authentification basique).
:::

Les journaux voyagent **en clair** (TCP) entre les hôtes et le serveur : réseau local et VPN site à site. Le transport chiffré viendra plus tard.

L'agent de l'hôte signale un VictoriaLogs qu'il voit en écoute (processus `victoria-logs`, ou port 9428 publié par Docker) : l'hôte apparaît alors en tête dans la fenêtre du rôle, avec ses ports.

## La page Logs

Réservée aux profils `admin` et `operator` : un journal peut contenir un secret. Elle n'est pas lisible avec une clé d'API.

| Filtre | Effet |
|---|---|
| Hôte | un hôte du hub, ou un émetteur que le hub ne connaît pas (« Autres émetteurs ») ; « aucun journal » : rien reçu depuis 24 h |
| Site, Tag | les hôtes du site ou du tag |
| Application | le programme qui a écrit la ligne (`sshd`, `systemd`, `CRON`…), parmi ceux de la période |
| Période | 15 min, 1 h (par défaut), 6 h, 24 h, 7 j, ou personnalisée (du… au…) |
| Texte du message | une suite de caractères du message, sans tenir compte de la casse (`err` trouve `error`) ; Entrée pour appliquer |
| Criticité minimale | Erreurs · Avertissements (par défaut) · Notices · Infos · Tout : chaque choix inclut les niveaux plus graves |
| Source | la catégorie sous laquelle le serveur a reçu la ligne (champ `source`) : choisie en cliquant la matrice, retirée par sa pastille |

- **Matrice** (à gauche, au-dessus de la liste) : le nombre de lignes de la période, une colonne par **source** (hôtes, ESPHome, Omada, Docker, et « sans source » pour les lignes reçues avant que le serveur ne les étiquette) et une ligne par criticité (critique regroupe les trois niveaux les plus graves). Elle montre **tous les niveaux**, quel que soit le filtre de criticité, et suit les autres filtres (hôte, site, tag, application, période, texte). Cliquer l'en-tête d'une colonne filtre sur la source ; cliquer une cellule filtre sur la source **et** règle la criticité minimale sur sa ligne (les niveaux plus graves sont inclus). Masquée en direct.
- **Histogramme** (à droite de la matrice) : nombre de lignes par tranche de temps, empilées par criticité. Cliquer sur une barre, ou glisser sur plusieurs, zoome sur cette période.
- **Liste** : heure, criticité, hôte, application, message, de la plus récente à la plus ancienne. **Charger plus ancien** continue la lecture.
- **Une ligne dépliée** montre le message entier et ses champs (facility, PID, adresse d'origine…), avec :
  - **Voir le contexte** : les 20 lignes d'avant et d'après sur le même hôte, toutes applications et criticités confondues ;
  - **Cet hôte**, **Cette application**, **Exclure** l'application : ajoute le filtre ;
  - **Copier**, et le lien vers la fiche de l'hôte.
- Les filtres sont dans l'adresse de la page : elle se partage et se retrouve avec le retour arrière du navigateur.

Un hôte est reconnu par le **nom d'hôte** de ses journaux, comparé à celui que son agent remonte (sans le domaine, sans la casse).

### Suivi en direct

**Direct** affiche les nouvelles lignes au fil de l'eau, en haut de la liste, avec les mêmes filtres (la période est ignorée, l'histogramme masqué). Descendre dans la liste met l'affichage en pause ; un bouton indique le nombre de nouvelles lignes et y revient. La liste garde 1000 lignes. Huit suivis au plus sont ouverts en même temps sur le hub.

## Sur la fiche d'un hôte

- Le bouton **Logs** de l'en-tête ouvre la page filtrée sur l'hôte.
- La ligne **Journaux** indique le dernier journal reçu et le nombre d'erreurs sur 24 h (lien vers ces erreurs). Ces valeurs sont relevées toutes les 5 minutes.

### Hôte muet

Un hôte dont l'option **Envoi des journaux** est conforme, en ligne, et dont le serveur n'a rien reçu depuis le délai réglé dans le rôle (**Hôte muet après**, 6 h par défaut, 0 pour ne pas surveiller) passe en **écart** sur cette option : « aucun journal reçu par … depuis N h ». L'écart se lève au premier journal reçu.

Les erreurs présentes dans les journaux ne changent pas l'état d'un hôte : seul le silence est signalé.

## Limites

- **Conteneurs Docker** : leurs journaux ne passent pas par journald (pilote `json-file`), ils ne sont donc pas envoyés.
- **Home Assistant OS, Windows, Unraid** : pas de standardisation ; l'envoi se règle à la main quand le système le permet.
- **Équipements sans agent** : un appareil réglé pour envoyer en syslog au serveur apparaît dans « Autres émetteurs » ; il n'est pas encore rattaché à sa fiche.

## API

Profils `admin` et `operator`, session seulement (pas de clé d'API). `404` sans rôle Serveur de logs.

| Route | Rôle de la route |
|---|---|
| `GET /api/logs` | lignes de la période, les plus récentes d'abord ; `limit` (200, 1000 au plus), `before` : heure de la dernière ligne de la page précédente |
| `GET /api/logs/hits` | nombre de lignes par tranche de temps et par criticité |
| `GET /api/logs/matrix` | nombre de lignes par source et par criticité (le filtre `severity` est ignoré : tous les niveaux) |
| `GET /api/logs/fields?field=app\|facility` | valeurs d'un champ sur la période, les plus fréquentes d'abord |
| `GET /api/logs/sources` | émetteurs des dernières 24 h, avec l'hôte du hub reconnu |
| `GET /api/logs/context?hostname=…&time=…` | lignes d'avant et d'après une ligne, sur son hôte |
| `GET /api/logs/tail` | suivi en direct (Server-Sent Events) |
| `POST /api/roles/log-reception` | test de réception d'un serveur en cours de déclaration : ligne syslog de test envoyée, puis cherchée par l'API (administrateurs) |
| `GET /api/settings/logs/:role/hosts` | hôtes qui envoient au serveur, avec leur état (administrateurs) |
| `POST /api/settings/logs/:role/hosts` | fait envoyer un hôte (`hostId`) et applique l'option (administrateurs, passkey) |
| `DELETE /api/settings/logs/:role/hosts/:hostId` | arrête l'envoi d'un hôte (administrateurs, passkey) |

Filtres communs : `role`, `host` (identifiants d'hôtes), `hostname` (noms bruts), `site`, `tag`, `severity` (0 à 7, criticité la moins grave gardée), `app`, `facility`, `source` (`_none` : sans source), `q`, `notApp`, `notHostname` ; listes séparées par des virgules. Période : `from` (date ISO ou durée `15m`, `1h`, `7d`) et `to` (date ISO).

Le hub construit lui-même la requête envoyée au serveur : aucune requête LogsQL n'est acceptée du navigateur.
