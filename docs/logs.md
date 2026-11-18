---
title: Logs
description: Journaux des hôtes et des conteneurs Docker centralisés sur un serveur de logs (VictoriaLogs), envoyés en syslog et lus dans la page Logs
sidebar_position: 3.6
---

# Logs

Les journaux des hôtes, et ceux de leurs conteneurs Docker, sont centralisés sur un **serveur de logs** et lus dans la page **Logs** de Homelab Manager.

```
hôtes (rsyslog, posé par la standardisation) ──────────syslog TCP──► serveur de logs (VictoriaLogs)
conteneurs (json-file) ── collecteur Fluent Bit ───────syslog TCP──►   (source=docker)
navigateur ──► hub ──API HTTP de requête──────────────────────────►
```

- **Les agents ne transportent aucun journal.** L'agent d'un hôte installe rsyslog (ou le collecteur des conteneurs) et écrit sa configuration ; ce sont eux qui envoient, directement au serveur.
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

Le vert d'une carte ne compte que les journaux de l'hôte : les lignes de ses conteneurs ont leur propre état (ci-dessous).

**Conteneurs** : sur la carte d'un hôte qui a des stacks Compose et envoie ses journaux par la standardisation, une seconde ligne suit les [journaux de ses conteneurs](#journaux-des-conteneurs-docker) :

| État | Signification |
|---|---|
| non suivis | pas activé ; bouton **Activer** |
| reçu il y a… (vert) | des lignes de conteneurs sont arrivées pendant le délai du rôle |
| orange | mise en place en cours, stack(s) à recréer, ou `/etc/docker/daemon.json` modifié sur l'hôte |
| rouge | collecteur absent ou arrêté, serveur injoignable, ou rien reçu |
| agent à mettre à jour | l'agent ne sait pas poser le collecteur (Docker et systemd requis) |

**Réappliquer** (orange ou rouge) remet le collecteur en place et propose de recréer des stacks ; l'icône d'arrêt coupe l'envoi des conteneurs seul. La **corbeille** de la carte arrête les deux.

Les émetteurs que le hub ne connaît pas sont listés sous les cartes.

## Journaux des conteneurs Docker

Les journaux des conteneurs ne passent ni par journald ni par rsyslog. Un collecteur **Fluent Bit**, posé et réglé par l'agent, lit les fichiers des conteneurs sur l'hôte et les envoie au serveur, en syslog RFC 5424 sur TCP, vers le listener étiqueté `source=docker` ([Installer VictoriaLogs](#installer-victorialogs)).

Prérequis : un agent qui annonce la capacité `docker_log_collect` (Docker et systemd ; pas Unraid pour l'instant), et un hôte qui **envoie déjà ses journaux** par la standardisation. Les journaux des conteneurs vont **toujours au serveur de l'hôte** : il n'y a pas de serveur à choisir.

### Activer

**Paramètres › Logs**, carte de l'hôte, **Activer** (administrateurs, passkey, journal d'audit). La boîte de confirmation dit si Docker va redémarrer, et liste les stacks à **recréer** dans la même tâche (cochées : stacks managées en marche ; grisées : non managées, arrêtées, déjà suivies). L'agent, dans l'ordre :

1. vérifie que le serveur accepte la connexion (sinon rien n'est modifié) ;
2. fusionne `/etc/docker/daemon.json` : pilote `json-file`, rotation `10m` × 3 sauf réglage existant, labels Compose (`com.docker.compose.project`, `com.docker.compose.service`) recopiés dans chaque ligne ; les `log-opts` inconnues de `json-file` sont retirées (affichées dans la tâche), les autres clés gardées. Le fichier est validé par `dockerd --validate`, puis **Docker redémarre** (tous les conteneurs de l'hôte, y compris ceux des stacks non managées et ceux lancés hors Compose). Fichier déjà conforme : pas de redémarrage ;
3. lance le collecteur : stack `homelab-log-collector`, image `fluent/fluent-bit` épinglée par empreinte, fichiers dans `/var/lib/homelab-agent/log-collector` ;
4. recrée les stacks cochées (`docker compose up -d --force-recreate`).

Une étape qui échoue remet `daemon.json` et le collecteur dans leur état d'avant. Une stack qui ne se recrée pas n'annule pas le reste : la tâche est en échec et la nomme.

Un conteneur garde les réglages de journaux de sa création : ceux créés avant l'activation **n'envoient rien** tant qu'ils ne sont pas recréés. Le bloc Docker de la fiche hôte les signale (« À recréer ») et propose **Recréer** ([Docker](docker.md#journaux-des-conteneurs)). Une stack arrêtée n'a pas d'état : elle n'envoie rien de toute façon.

### Suivre le serveur de l'hôte

L'hôte ne garde que « activé ». À chaque rapport Docker, le hub compare la destination du collecteur au serveur de l'hôte (option **Envoi des journaux**, adresse et port du rôle) et, s'ils diffèrent, remet le collecteur sur le bon serveur. Ce recalage **ne redémarre jamais Docker** : un collecteur absent ou un `daemon.json` modifié à la main attendent **Réappliquer**. Une tentative en échec n'est pas répétée pour la même destination. Un hôte qui n'envoie plus ses journaux arrête aussi ceux de ses conteneurs.

### Arrêter

L'agent supprime le collecteur et retire les labels de `daemon.json`, **sans redémarrer Docker** (ils partent au prochain redémarrage). Les conteneurs restent en `json-file` : `docker logs` fonctionne toujours. Ce que le serveur a reçu est gardé.

### Contenu d'une ligne

| Champ | Valeur |
|---|---|
| `hostname` | nom de l'hôte |
| `app_name` | service Compose |
| `hlm@32473.compose_project` | stack |
| `hlm@32473.container_id` | conteneur (12 caractères) |
| `hlm@32473.stream` | `stdout` ou `stderr` |
| `facility` | `user` |
| `source` | `docker` (posé par le listener) |

`32473` est un numéro d'entreprise de documentation (RFC 5612) : l'identifiant `hlm@32473` est provisoire. Le BOM UTF-8 que Fluent Bit place en tête du message (RFC 5424) est retiré à l'affichage.

### Criticité

Les pilotes de Docker ne connaissent pas la criticité d'une ligne : le collecteur la déduit du texte. La première règle qui s'applique l'emporte :

1. **niveau structuré** : pino (`"level":60` critique, `50` erreur, `40` avertissement, `10`–`30` info), MongoDB (`"s":"F"`, `"E"`, `"W"`, `"I"`), `level` en JSON ou en logfmt (`fatal`, `panic`, `crit`… / `error` / `warn` / `info`, `debug`) ;
2. **mots-clés** du message : `fatal`, `panic`, `critical` → critique ; `error`, `exception`, `failed`, `failure` → erreur ; `warn`, `warning` → avertissement ;
3. sinon **info**.

### Non envoyés

- les conteneurs lancés hors Compose (sans label de service) ;
- le collecteur lui-même.

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
      - -retentionPeriod=7d
      - -httpListenAddr=:9428
      - -syslog.listenAddr.tcp=:514
      # journaux des conteneurs Docker : un second listener TCP, étiqueté source=docker
      - -syslog.listenAddr.tcp=:517
      - -syslog.extraFields.tcp={"source":"host"}
      - -syslog.extraFields.tcp={"source":"docker"}
      - -syslog.useRemoteIP.tcp=true
    volumes:
      - ./data:/victoria-logs-data
```

| Réglage | Rôle |
|---|---|
| `-httpListenAddr` (9428) | API de requête, lue par le hub |
| `-syslog.listenAddr.tcp` (514) | réception des journaux des hôtes, en TCP ; un port sous 1024 demande que le processus soit root ou ait `CAP_NET_BIND_SERVICE` |
| `-retentionPeriod` | durée de conservation (7 jours par défaut, valeur de l'exemple) ; réglage du serveur à faire à la main dans son compose, le hub ne le modifie pas ; `-retention.maxDiskSpaceUsageBytes` borne aussi le disque |
| `-syslog.useRemoteIP.tcp` | garde l'adresse de l'émetteur de chaque journal (champ `remote_ip`) |
| `-syslog.extraFields.tcp` | champs ajoutés aux lignes d'un listener, **appariés par position** aux `-syslog.listenAddr.tcp` (l'ordre compte) : `source` range les lignes dans la matrice de la page Logs |

Le collecteur des conteneurs envoie au listener TCP étiqueté `source=docker` (517 dans l'exemple), à la même adresse que les hôtes. Le hub le lit dans la configuration du serveur (`/flags`) ; le champ **Port Docker** du rôle l'impose ([Rôles](roles.md#serveur-de-logs)).

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

- **Matrice** (à gauche, au-dessus des filtres) : comme la matrice de la page Hôtes, elle **filtre la page** et n'est pas filtrée par elle : elle compte les lignes de la **période** (et du serveur choisi), quels que soient l'hôte, le site, l'application, la source ou la criticité retenus. Une colonne par **source** (hôtes, ESPHome, Omada, Docker, et « sans source » pour les lignes reçues avant que le serveur ne les étiquette), une ligne par criticité (critique regroupe les trois niveaux les plus graves), la couleur de la case est sa criticité. Cliquer l'en-tête d'une colonne filtre sur la source, celui d'une ligne règle la criticité minimale, une case fait les deux (les niveaux plus graves sont inclus) ; un second clic retire le filtre. La source ou la case active est cerclée. Masquée en direct.
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

### Masquer l'historique d'un hôte

Une fois l'investigation faite et les actions décidées, **Masquer l'historique** (administrateurs, passkey) repart d'une page propre pour un hôte : filtrer sur l'hôte (ou un site, un tag), le bouton affiche un aperçu « N lignes masquées » par hôte, puis pose un **repère** à l'instant présent.

- Rien n'est supprimé sur le serveur : le hub écarte à la lecture les lignes de l'hôte plus anciennes que le repère. Liste, histogramme, matrice, émetteurs, valeurs des filtres, contexte et direct respectent le masque, pour que les compteurs et la liste concordent.
- Une pastille « historique masqué avant le … » rappelle chaque repère ; **Afficher l'historique masqué** lit tout, sans modifier les repères ; **Tout réafficher** les retire.
- Un repère est posé par **nom d'hôte brut** : il couvre aussi un émetteur inconnu du hub. Masquer de nouveau le même hôte déplace le repère.
- La détection d'hôte muet ([ci-dessous](#hôte-muet)) lit les lignes brutes : masquer un hôte ne le fait pas passer en « rien reçu ».
- Pose et retrait sont inscrits au journal d'audit. Un repère plus ancien que la rétention du serveur n'a plus d'effet (il reste en base, inoffensif).

## Sur la fiche d'un hôte

- Le bouton **Logs** de l'en-tête ouvre la page filtrée sur l'hôte.
- La ligne **Journaux** indique le dernier journal reçu et le nombre d'erreurs sur 24 h (lien vers ces erreurs). Ces valeurs sont relevées toutes les 5 minutes.

### Hôte muet

Un hôte dont l'option **Envoi des journaux** est conforme, en ligne, et dont le serveur n'a rien reçu depuis le délai réglé dans le rôle (**Hôte muet après**, 6 h par défaut, 0 pour ne pas surveiller) passe en **écart** sur cette option : « aucun journal reçu par … depuis N h ». L'écart se lève au premier journal reçu.

Les erreurs présentes dans les journaux ne changent pas l'état d'un hôte : seul le silence est signalé.

## Limites

- **Conteneurs Docker** : seuls ceux lancés par Docker Compose sont envoyés, sur un hôte Docker avec systemd qui envoie ses journaux par la standardisation (pas encore Unraid) ; un conteneur créé avant l'activation n'envoie qu'une fois recréé ; la criticité est déduite du texte.
- **Home Assistant OS, Windows, Unraid** : pas de standardisation ; l'envoi se règle à la main quand le système le permet.
- **Équipements sans agent** : un appareil réglé pour envoyer en syslog au serveur apparaît dans « Autres émetteurs » ; il n'est pas encore rattaché à sa fiche.

## API

Profils `admin` et `operator`, session seulement (pas de clé d'API). `404` sans rôle Serveur de logs.

| Route | Rôle de la route |
|---|---|
| `GET /api/logs` | lignes de la période, les plus récentes d'abord ; `limit` (200, 1000 au plus), `before` : heure de la dernière ligne de la page précédente |
| `GET /api/logs/hits` | nombre de lignes par tranche de temps et par criticité |
| `GET /api/logs/matrix` | nombre de lignes par source et par criticité, tous niveaux ; la page ne lui passe que la période et le serveur, les autres filtres sont acceptés |
| `GET /api/logs/fields?field=app\|facility` | valeurs d'un champ sur la période, les plus fréquentes d'abord |
| `GET /api/logs/sources` | émetteurs des dernières 24 h, avec l'hôte du hub reconnu |
| `GET /api/logs/context?hostname=…&time=…` | lignes d'avant et d'après une ligne, sur son hôte |
| `GET /api/logs/tail` | suivi en direct (Server-Sent Events) |
| `GET /api/logs/cutoffs` | repères d'historique masqué ; avec `preview=true` et une sélection (`host`, `hostname`, `site`, `tag`), le nombre de lignes que masquer cette sélection écarterait, par hôte |
| `PUT /api/logs/cutoffs` | masque l'historique de la sélection jusqu'à maintenant, 400 si elle ne contient aucun hôte (administrateurs, passkey) |
| `DELETE /api/logs/cutoffs` | réaffiche l'historique de la sélection, de tous les hôtes sans sélection (administrateurs, passkey) |
| `POST /api/roles/log-reception` | test de réception d'un serveur en cours de déclaration : ligne syslog de test envoyée, puis cherchée par l'API (administrateurs) |
| `GET /api/settings/logs/:role/hosts` | hôtes qui envoient au serveur, avec leur état (administrateurs) |
| `POST /api/settings/logs/:role/hosts` | fait envoyer un hôte (`hostId`) et applique l'option (administrateurs, passkey) |
| `DELETE /api/settings/logs/:role/hosts/:hostId` | arrête l'envoi d'un hôte, et celui de ses conteneurs (administrateurs, passkey) |
| `PUT /api/hosts/:id/docker-logs` | journaux des conteneurs : `{ "enabled": true, "recreate": ["stack"…] }` les met en place (et recrée ces stacks), `{ "enabled": false }` les arrête (administrateurs, passkey) ; `202 { jobId }` |

Filtres communs : `role`, `host` (identifiants d'hôtes), `hostname` (noms bruts), `site`, `tag`, `severity` (0 à 7, criticité la moins grave gardée), `app`, `facility`, `source` (`_none` : sans source), `q`, `notApp`, `notHostname`, `showMasked` (lit aussi l'historique masqué) ; listes séparées par des virgules. Période : `from` (date ISO ou durée `15m`, `1h`, `7d`) et `to` (date ISO).

Le hub construit lui-même la requête envoyée au serveur : aucune requête LogsQL n'est acceptée du navigateur.
