---
title: Sécurité
description: Connexion chiffrée et authentifiée entre le hub et les agents, signature des binaires de l'agent
sidebar_position: 6
---

# Sécurité

Le hub expose deux ports :

| Port | Usage | Protection |
|---|---|---|
| `3000` | interface web et API REST | comptes et profils, voir [Comptes et profils](comptes.md) |
| `3443` | agents : script d'installation, binaires, enrôlement, connexion WebSocket | TLS, épinglage de la clé du hub, un certificat par agent |

Rien ne circule en clair entre le hub et les agents, et aucun secret réutilisable n'est transmis.

## Autorité de certification interne

Au premier démarrage, le hub crée sa propre autorité de certification (ECDSA P-256, valable 20 ans) et son certificat serveur (10 ans). Ils sont stockés dans MongoDB (collection `settings`, document `pki`). Il n'y a besoin ni d'une autorité publique ni d'un nom de domaine.

Les empreintes sont affichées dans **Paramètres > Agent** : adresse des agents, clé épinglée du serveur, empreinte SHA-256 de l'autorité.

## Installation : épinglage de la clé du hub

La commande d'installation contient l'empreinte de la clé publique du serveur :

```bash
curl -fsSLk --pinnedpubkey sha256//CLÉ https://IP_DU_HUB:3443/install.sh | sh -s -- CODE
```

- `--pinnedpubkey` : curl refuse la connexion si le serveur ne présente pas exactement cette clé, ce qui écarte un faux hub (usurpation d'IP, de DNS ou d'ARP). `-k` ne désactive que la vérification par une autorité publique et le contrôle du nom ; l'épinglage les remplace.
- Le script, reçu par ce canal épinglé, dépose le certificat de l'autorité du hub dans `/etc/homelab-agent/ca.pem`, puis télécharge le binaire de l'agent avec le même épinglage.
- curl est donc requis : wget ne sait pas épingler une clé.

Pour vérifier la clé à la main depuis un hôte :

```bash
openssl s_client -connect IP_DU_HUB:3443 </dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary | base64
```

Le résultat doit être identique à la clé épinglée affichée dans les paramètres.

## Enrôlement

- La commande d'installation contient un **code à usage unique, valable 24 h**. Le hub n'en garde que le hash. Une nouvelle commande annule la précédente.
- L'agent génère **sa clé privée sur l'hôte** (`/etc/homelab-agent/agent.key`, droits 600). Elle ne quitte jamais l'hôte : l'agent envoie au hub une demande de certificat (CSR) accompagnée du code.
- Le hub consomme le code, puis signe un **certificat client** : nom = identifiant de l'hôte, usage « authentification client » uniquement, valable 5 ans. Il retient l'empreinte de ce certificat sur l'hôte.
- Les codes invalides sont limités à 10 essais par IP toutes les 10 minutes.
- **Installation depuis l'inventaire Proxmox VE** ([Proxmox VE](proxmox-ve.md#installer-lagent-depuis-linventaire)) : l'agent d'un nœud (root) lance l'installateur dans un CT (`pct exec`) ou sur un autre nœud (SSH, clé d'hôte vérifiée par les fichiers de Proxmox VE). Les commandes sont fixes et le code d'enrôlement passe **sur l'entrée standard** : il n'apparaît ni dans une ligne de commande, ni dans le journal du job. L'agent reçoit le code du hub par la liaison TLS mutuelle.

## Connexion des agents (TLS mutuel)

- L'agent vérifie que le certificat du hub est signé par l'autorité de `ca.pem` et qu'il porte l'usage « serveur ». Le nom d'hôte n'est pas contrôlé : changer l'IP ou le nom du hub ne casse rien.
- Le hub exige un certificat client signé par son autorité, **et** dont l'empreinte est celle retenue pour l'hôte.
- Il n'y a ni jeton ni mot de passe : rien d'utile à intercepter.

## Révocation

- **Révoquer l'agent**, sur la fiche de l'hôte (**Options** › **Danger**) : la connexion est coupée immédiatement, le certificat et toute commande d'installation en attente sont refusés. L'hôte et son historique sont conservés ; pour le reconnecter, il faut une nouvelle commande d'installation.
- **Supprimer l'hôte** a le même effet sur l'agent.
- **Nouvelle commande d'installation** : l'agent en place continue de fonctionner jusqu'à ce que la nouvelle installation s'enrôle et remplace son certificat.

## Signature des binaires de l'agent

Les binaires de l'agent livrés dans une release sont **signés** (Ed25519) par la clé de release du projet, et chaque agent embarque la clé publique correspondante. À chaque mise à jour automatique, l'agent vérifie l'empreinte SHA-256 annoncée par le hub **et** la signature. Si la signature est absente ou invalide, il refuse la mise à jour et garde sa version.

Ainsi, même un hub compromis ne peut pas pousser sur les hôtes un agent qui ne sort pas du processus de release.

Les agents de développement (`make dev`, ou `make docker-build` sans clé de release) n'embarquent pas de clé : ils acceptent une mise à jour sur la seule empreinte et l'indiquent dans leurs logs (`development build`). **Paramètres > Agent** précise si les binaires distribués par le hub sont signés.

### Version minimum (anti-retour arrière)

La signature porte aussi la **version** du binaire et sa **plateforme** (fichier `.sig2`). Chaque agent de release embarque une **version minimum** (`agent/MIN_VERSION`) et refuse toute mise à jour vers une version plus ancienne, même correctement signée. Sans cela, un hub compromis pourrait ramener un agent vers une ancienne version signée, d'avant un correctif de sécurité (par exemple, une version antérieure à la politique locale, qui acceptait n'importe quelle image de sauvegarde). Au-dessus de ce plancher, le retour à une version précédente reste possible : on peut revenir à la release d'avant du hub sans bloquer les agents.

- Le plancher est affiché dans **Paramètres > Agent** (agents distribués par le hub) et sur la fiche de l'hôte (**Options** › **Agent**). Un agent plus récent que le hub, ou dont le plancher est au-dessus de ce que le hub distribue, est marqué « plus récent que le hub » : aucune mise à jour ne lui est proposée.
- Pour redescendre sous le plancher, il faut une action en root sur l'hôte : réinstaller l'agent avec la commande d'installation.
- Les agents d'avant cette protection (≤ 1.0.12) vérifient encore l'ancienne signature (`.sig`), toujours publiée : ils se mettent à jour normalement, puis sont protégés.

**Mainteneur.** Le plancher se monte à la main, dans la release qui corrige une faille de l'agent : `make agent-floor` (plancher = version courante de l'agent), puis un commit à part. Il ne dépend d'aucune option de build : le `Dockerfile` lit `agent/MIN_VERSION` et refuse une release dont le plancher manque ou dépasse la version de l'agent, et `make docker-release` refuse un plancher plus bas que celui de la release précédente. Un agent de release construit sans plancher refuse toute mise à jour.

### Clé de release (mainteneur)

1. Une seule fois : `make release-key`. La clé privée est écrite dans `~/.config/homelab-manager/release.key` (droits 600, hors du dépôt ; autre chemin possible avec `RELEASE_KEY=…`). La clé publique est écrite dans `agent/release.pub`, **à commiter**.
2. `make docker-release` vérifie que la clé correspond à `agent/release.pub`, la passe au build comme secret BuildKit (elle n'est jamais copiée dans l'image), signe les binaires et embarque la clé publique dans les agents. Sans clé, la release est refusée.

:::warning Sauvegarder la clé de release
Si la clé est perdue ou remplacée, les agents installés refusent les binaires signés par la nouvelle clé. Il faut alors lancer une fois, sur chaque hôte, la commande de mise à jour manuelle (**Paramètres > Agent**) : elle passe par le canal épinglé et installe un agent qui embarque la nouvelle clé.
:::

## Politique locale de l'hôte

Le fichier `/etc/homelab-agent/policy.json` (dossier de l'agent) fixe ce que l'agent accepte de son hub. Il appartient à root sur l'hôte et le hub n'a aucun moyen de le modifier : un hub ou un compte administrateur compromis ne peut donc pas se servir des sauvegardes ou de l'installation d'agents pour prendre la main sur l'hôte. Il est relu à chaque usage : une modification s'applique sans redémarrer l'agent.

- **Sans fichier** (nouvelle installation, ou agent mis à jour) : l'agent écrit la politique stricte ci-dessous au démarrage. Un fichier existant n'est jamais remplacé.
- **Assouplir un hôte** : modifier le fichier à la main, en root, sur l'hôte ; il est relu à chaque usage.
- **Fichier illisible ou invalide** (clé inconnue, valeur hors liste) : tout ce qu'il régit est refusé, et l'erreur est écrite dans le journal de l'agent.

```json
{
  "agentInstall": true,
  "backup": {
    "deny": ["/etc/shadow", "/etc/gshadow", "/etc/ssh", "/root/.ssh", "/etc/homelab-agent", "/var/run/docker.sock", "/run/docker.sock"],
    "pbsFingerprints": [],
    "pinPbs": true,
    "images": []
  }
}
```

| Clé | Rôle |
|---|---|
| `agentInstall` | nœud Proxmox VE : autorise l'installation d'agents dans ses CT et sur les autres nœuds (absent : refusé) |
| `backup.deny` | dossiers jamais sauvegardés : une archive qui s'y trouve est refusée, une archive qui les contient les exclut |
| `backup.pbsFingerprints` | empreintes des PBS autorisés. Liste vide avec `pinPbs` : le premier PBS utilisé est retenu (`/var/lib/homelab-agent/pbs-pin`) et lui seul est accepté ensuite ; pour changer de PBS, supprimer ce fichier ou lister le nouveau |
| `backup.images` | images du client de sauvegarde autorisées en plus de celles embarquées dans l'agent |

### Dans l'interface

L'agent remonte sa politique au hub, qui l'affiche en lecture seule dans la fiche de l'hôte (onglet Sauvegardes, encadré de l'agent) : le fichier, les dossiers jamais sauvegardés et le PBS autorisé ou épinglé. Le hub ne peut ni épingler ni déverrouiller :

- **Verrouillage** : automatique, à la première sauvegarde de l'hôte.
- **PBS principal changé** (réaffectation du rôle, nouveau certificat) : les hôtes qui refuseront le nouveau PBS sont listés dans **Paramètres › Rôles**, avec la commande à lancer sur chacun, et signalés à l'enregistrement.
- **Déverrouillage** : sur l'hôte, `rm /var/lib/homelab-agent/pbs-pin` (le PBS suivant est épinglé), ou ajout de l'empreinte du nouveau PBS à `backup.pbsFingerprints`.

### Image du client de sauvegarde

Un agent de release embarque l'image du client de sauvegarde par son digest (`@sha256:…`) et refuse toute autre image, avec ou sans politique locale. Une image personnalisée doit être ajoutée à `backup.images` sur chaque hôte concerné.

### Installation depuis Proxmox VE

Le nœud copie son propre binaire, déjà vérifié, dans le CT ou sur l'autre nœud, puis lance `homelab-agent install`. Aucun script du hub n'y est exécuté. Le code d'enrôlement et l'autorité du hub passent sur l'entrée standard.

## Base de données et secrets

Deux options, facultatives et indépendantes, se règlent dans le fichier `.env` à côté du `compose.yml` (modèle : `.env.example`). Le réseau interne `backend` du `compose.yml` vaut pour toutes les installations : MongoDB n'est joignable que par le hub et n'a aucune route vers l'extérieur.

- **Compte MongoDB** (`MONGO_USERNAME`, `MONGO_PASSWORD`) : la base refuse toute connexion sans mot de passe. Le hub se connecte avec ce compte, défini dans la base `admin` (`MONGO_AUTH_SOURCE` pour une autre) ; un compte dédié avec le seul rôle `readWrite` sur `homelab` convient aussi.
- **Clé maître** (`HM_MASTER_KEY`, 32 octets en base64, ou `HM_MASTER_KEY_FILE` pour un secret Docker) : le hub chiffre (AES-256-GCM) les secrets qu'il stocke :
  - les clés privées de l'autorité des agents et du certificat serveur ;
  - les jetons des PBS principal et hors site, des clusters Proxmox VE et de chaque hôte ;
  - le secret client Omada et le mot de passe du broker MQTT.

  Un dump ou une copie de `mongo-data` ne livre alors plus aucun secret. Les mots de passe des comptes, les clés d'API et les codes d'enrôlement sont déjà hachés.

Avec la clé maître :

- au démarrage, le hub chiffre ce qui est encore en clair ; ce qu'il écrit ensuite est chiffré dans la seconde ;
- **sans sa clé**, ou avec une autre, le hub **refuse de démarrer** si la base contient des secrets chiffrés. Il ne recrée jamais d'autorité, ce qui couperait tous les agents ;
- la clé est à **sauvegarder à part** de la base (gestionnaire de mots de passe, coffre). Perdue, les secrets sont irrécupérables : restaurer une sauvegarde d'avant le chiffrement, ou repartir d'une base vide et réinstaller tous les agents ;
- un hub d'une version antérieure ne sait pas lire une base chiffrée.

### Migrer une installation existante

Hub en marche et **à jour** (`docker compose pull && docker compose up -d` : un hub plus ancien ne connaît ni le compte ni la clé), dans le dossier du `compose.yml`, avec le `compose.yml` à jour (réseau `backend`, variables `MONGO_*` et `HM_MASTER_KEY`) :

1. **Sauvegarder la base** (retour arrière) :
   ```bash
   docker exec homelab-manager-mongo mongodump --quiet --db homelab --archive --gzip > avant-migration.archive.gz
   ```
2. **Créer le `.env`**, puis noter son contenu dans un gestionnaire de mots de passe :
   ```bash
   cat > .env <<EOF
   MONGO_USERNAME=root
   MONGO_PASSWORD=$(openssl rand -hex 24)
   HM_MASTER_KEY=$(openssl rand -base64 32)
   EOF
   chmod 600 .env
   ```
3. **Créer le compte dans la base**, qui n'a pas encore d'authentification :
   ```bash
   . ./.env && docker exec homelab-manager-mongo mongosh admin --quiet \
     --eval "db.createUser({user: '$MONGO_USERNAME', pwd: '$MONGO_PASSWORD', roles: ['root']})"
   ```
4. **Redémarrer** avec l'authentification et la clé : `docker compose up -d`. Les variables `MONGO_INITDB_ROOT_*` activent `--auth` sur la base existante ; le compte, lui, n'est créé que sur une base vide, d'où l'étape 3.
5. **Vérifier** :
   - `docker compose logs hub | grep secrets` affiche `stored secrets sealed with the master key` ;
   - les agents restent connectés (liste des hôtes) : l'autorité n'a pas changé ;
   - `docker exec homelab-manager-mongo mongosh homelab --quiet --eval 'db.settings.countDocuments()'` est refusé (`requires authentication`).
6. **Mettre à jour le script de sauvegarde** avec le compte (voir [Données](configuration.md#données)).

**Retour arrière** : restaurer le dump de l'étape 1 (`mongorestore --drop`, authentifié si le compte est actif), retirer `HM_MASTER_KEY` du `.env`, puis `docker compose up -d`. Pour retirer aussi l'authentification, vider `MONGO_USERNAME` et `MONGO_PASSWORD`.

## En-têtes de sécurité HTTP

Toutes les réponses du hub (API, fichiers de l'interface, page d'accueil) portent :

| En-tête | Valeur |
|---|---|
| `Content-Security-Policy` | `default-src 'self'`, `script-src 'self'`, `style-src 'self'`, `connect-src 'self'`, `img-src 'self' data:`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'` : aucun script ni style inline, l'interface ne parle qu'à son propre hub |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Strict-Transport-Security` | `max-age=604800`, uniquement en HTTPS (voir ci-dessous) |

L'interface ne peut donc plus être affichée dans une `iframe`, et une injection de script n'est pas exécutée.

HSTS n'est envoyé que si le navigateur est en HTTPS : derrière un proxy déclaré dans `TRUST_PROXY` (`X-Forwarded-Proto: https`), ou sur le port HTTPS natif avec un certificat fourni (`HTTPS_CERT_FILE`). Avec le certificat que le hub émet lui-même, il n'est pas envoyé : le navigateur refuserait toute exception pour un certificat auto-signé. La durée est volontairement courte, sans `includeSubDomains` ni `preload`.

## Déploiement durci

`compose.hardened.yml` est un déploiement de référence à utiliser **à la place** de `compose.yml` (`docker compose -f compose.hardened.yml up -d`). Il rend obligatoire ou actif ce que le compose standard laisse en option :

| Mesure | Détail |
|---|---|
| HTTPS | interface sur le [port HTTPS natif](configuration.md#https-natif), cookie `Secure` forcé ; le port HTTP `3000` n'écoute que sur la boucle locale du conteneur (sonde de santé), jamais publié |
| Ports liés | `HM_UI_BIND` (interface) et `HM_AGENT_BIND` (agents) : adresse de l'hôte à renseigner, sans valeur par défaut ; `127.0.0.1` pour un proxy sur le même hôte |
| Réseau interne | MongoDB n'est joignable que par le hub, sans route vers l'extérieur |
| Conteneurs durcis | `read_only`, `cap_drop: [ALL]`, `no-new-privileges` ; MongoDB tourne en uid 999, sans capacité |
| Authentification | compte MongoDB (`--auth`) et clé maître **obligatoires** : le compose refuse de démarrer sans eux |
| Images | identifiées par leur empreinte (`image@sha256:…`) |

Mise en route : renseigner le `.env` (champs listés en tête du fichier), `chown 999:999 mongo-data mongo-config`, puis démarrer. À chaque montée de version, remplacer l'empreinte du hub : `make hardened-pin TAG=<version>` affiche les lignes à reporter (mongo comprise). Pour une installation existante, suivre d'abord la [migration de la base](#migrer-une-installation-existante) : ce compose crée une base avec compte.

### Page Sécurité

**Paramètres › Sécurité** (admins) contrôle la posture de l'installation vue depuis le hub :

- HTTP ou HTTPS et cookie `Secure` pour la requête en cours, proxy de confiance ;
- double authentification des admins : passkeys proposées (`WEBAUTHN_RP_ID`), obligatoires (`MFA_REQUIRED`), admins sans passkey ([Passkeys](comptes.md#passkeys)) ;
- compte MongoDB et clé maître ;
- binaires d'agent signés, version minimum, agents en retard sur une protection (version, politique locale) ;
- brokers MQTT : accès anonyme, TLS ;
- conteneur du hub : utilisateur non root, système de fichiers en lecture seule, capacités retirées, `no-new-privileges`.

Un point « non vérifiable » signale ce que le hub ne peut pas voir, comme les ACL du broker MQTT sur les topics de commande : à contrôler sur le broker ([exemple d’ACL](home-assistant.md#sécurité-des-commandes)).

## Ce qui est protégé, et contre quoi

| Menace | Protection |
|---|---|
| Écoute du réseau local | TLS sur tous les échanges avec les agents ; aucun secret réutilisable ne circule |
| Faux hub au moment de l'installation (usurpation d'IP, DNS, ARP) | clé du hub épinglée dans la commande d'installation |
| Faux hub après l'installation | l'agent n'accepte que l'autorité du hub, avec l'usage « serveur » |
| Agent qui tenterait de se faire passer pour le hub | les certificats d'agent n'ont que l'usage « client » |
| Commande d'installation récupérée après coup (historique shell, capture d'écran) | code à usage unique, valable 24 h |
| Faux agent | certificat client signé par le hub et dont l'empreinte est enregistrée pour l'hôte |
| Hôte compromis ou retiré du parc | « Révoquer l'agent » ou suppression de l'hôte |
| Binaire modifié pendant une mise à jour, hub compromis | signature de release vérifiée par l'agent |
| Mot de passe d'un admin volé ou deviné | [passkey](comptes.md#passkeys) demandée après le mot de passe, obligatoire pour les admins avec `MFA_REQUIRED` |
| Session d'un admin volée (cookie) | passkey redemandée avant les [actions sensibles](comptes.md#actions-sensibles) |
| Hub ou compte administrateur compromis | [politique locale](#politique-locale-de-lhôte) de l'hôte, image du client de sauvegarde épinglée |
| Vol de la base MongoDB ou d'une sauvegarde | mots de passe hachés (scrypt), codes d'enrôlement hachés ; avec la [clé maître](#base-de-données-et-secrets), secrets chiffrés (sinon la clé de l'autorité y figure en clair) |
| Accès à MongoDB depuis un autre conteneur | réseau interne `backend` ; [compte MongoDB](#base-de-données-et-secrets) |

## Réseau d'accès Tailscale

Un agent du réseau Tailscale joint le hub par son adresse tailnet, sur le même port TLS : la PKI est inchangée (clé du hub épinglée à l'installation, autorité du hub à la connexion, pas de vérification du nom). Le script d'installation ne reprend l'adresse Tailscale que si l'agent l'a lui-même utilisée pour le télécharger, afin qu'un hôte du LAN ne reçoive jamais une adresse qu'il ne sait pas joindre. Les ACL Tailscale (agent → hub sur le port des agents seulement) sont à régler côté tailnet.

## Limites

- **Le hub est l'équivalent d'un accès root sur le parc.** Un hub, une base MongoDB ou un compte administrateur compromis ne peut pas installer un agent non signé, mais des fonctions légitimes (image du client de sauvegarde, répertoires sauvegardés, standardisation, installation d'agents depuis Proxmox VE) lui permettent d'agir en root sur les hôtes ou d'en lire les fichiers. La [politique locale](#politique-locale-de-lhôte) en borne une partie, sur les hôtes qui en ont une. Le hub et ses comptes administrateurs sont à protéger en conséquence : voir l'[audit de sécurité](audit-securite.md).
- À l'installation initiale, tout vient du hub. La sécurité repose sur la commande copiée depuis l'interface, et donc sur l'accès à cette interface.
- Il n'y a pas de protection contre le retour à une version plus ancienne : un hub compromis peut redistribuer un ancien agent signé.
- L'autorité du hub vit dans MongoDB : si la base est perdue sans sauvegarde, ou sa clé maître perdue, tous les agents sont à réinstaller.
- Les certificats ne sont pas renouvelés automatiquement : 5 ans pour les agents (une réinstallation en délivre un nouveau), 10 ans pour le serveur, 20 ans pour l'autorité.
- Le port `3443` doit rester en accès direct, ou passer par un proxy TCP (*passthrough*). Un reverse proxy qui termine le TLS casserait l'épinglage et l'authentification des agents.
- L'interface (port `3000`) est servie en HTTP par défaut. Pour du HTTPS : un reverse proxy, ou le [port HTTPS natif](configuration.md#https-natif) (`HTTPS_PORT`), les deux pouvant se combiner quand le proxy est sur une autre machine. Un bandeau signale une page servie en HTTP, et aux admins un trajet proxy → hub en clair. Le certificat émis par le hub s'accepte comme exception ; son autorité ne doit pas être importée dans un navigateur ou un système (pas de contrainte de nom).
