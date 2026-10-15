---
title: Sauvegardes
description: Suivi des sauvegardes d'un Proxmox Backup Server, des jobs vzdump de Proxmox VE rattachés aux CT et VM, sauvegardes de répertoires lancées par les agents et sauvegardes internes de Home Assistant, avec alertes dans l'interface et Home Assistant
sidebar_position: 3.7
---

# Sauvegardes

Homelab Manager suit les sauvegardes d'un **Proxmox Backup Server** (PBS) et les rattache aux hôtes. Il suit aussi les sauvegardes internes de **Home Assistant OS**, lues par l'agent. Cinq sortes, affichées dans la colonne **Type** (plus **Nextcloud AIO** quand le [plugin](#plugin-nextcloud-aio) est utilisé) :

| Type | Origine | Rattachement à l'hôte | Retard jugé sur |
|---|---|---|---|
| **image PVE** | job de sauvegarde (vzdump) d'un cluster Proxmox VE : image complète du CT ou de la VM | automatique : l'hôte est le guest qui porte une de ses adresses MAC | la planification du job |
| **répertoires** | sauvegarde définie dans Homelab Manager et lancée par l'agent de l'hôte | automatique : le hub a créé le job, il connaît son groupe | la planification du job |
| **base PostgreSQL / MongoDB** | dump de bases défini dans Homelab Manager, fait et envoyé par l'agent de l'hôte ([détail](#sauvegardes-de-bases-de-données)) | automatique, comme les répertoires | la planification du job |
| **externe** | faite hors Homelab Manager (`backup_pbs_scripts` par cron, ElkarBackup…) | à la main, depuis la fiche hôte | le rythme appris de ses snapshots |
| **Home Assistant** | sauvegarde faite par Home Assistant (Paramètres › Système › Sauvegardes), une ligne par destination | automatique : l'agent HAOS de l'hôte | la planification des sauvegardes automatiques de HA |

Le PBS reste la référence : un snapshot n'est « fait » que lorsqu'il est sur le PBS. Exception : les sauvegardes Home Assistant, dont la référence est Home Assistant lui-même.

## Mise en place

Paramètres › **Sauvegardes** : un bloc **Proxmox Backup Server** et un bloc **Clusters Proxmox VE**, sur le même modèle : une ligne par serveur (adresse, état du dernier relevé, jeton), et une fenêtre d'édition avec la connexion à gauche (adresse, empreinte du certificat, jeton, test) et la création du jeton à droite.

### Jetons : une commande à usage unique

Les jetons ne se recopient pas à la main. À côté de **Générer la commande**, l'**identifiant du jeton** (`utilisateur@royaume!nom`) est pré-rempli et modifiable ; le bouton donne une ligne à coller dans un shell root du serveur (le PBS, ou un nœud du cluster) :

```bash
curl -fsSLk --pinnedpubkey sha256//… https://hub:3443/token-setup.sh | sh -s -- <code>
```

- Le script vient du port des agents du hub, dont la clé est épinglée : rien d'autre ne peut répondre.
- Le **hub décide** de ce qui est créé (utilisateur, jeton, chemin et rôle) ; le script crée l'utilisateur s'il manque, le jeton, les droits de l'utilisateur **et** du jeton (les droits d'un jeton sont l'intersection des siens et de ceux de son utilisateur), puis renvoie le jeton au hub, qui le range au bon endroit. **Le secret n'est jamais affiché.**
- Code à usage unique, valable 1 heure. Le serveur doit joindre le port des agents du hub.
- L'**identifiant** se change quand un jeton de ce nom existe déjà sur le serveur sans que le hub connaisse son secret ; le royaume est `pbs` pour le PBS et les hôtes, `pve` pour un cluster.
- Recoller une commande pour un jeton **que le hub détient** met seulement ses droits à jour (secret conservé).
- Repli : le bloc « Sans la commande » fait la même chose et affiche le secret à recopier dans le formulaire.

| Jeton | Utilisateur | Rôle et chemin |
|---|---|---|
| lecture du PBS | `homelab@pbs` | `DatastoreAudit` sur `/datastore` |
| lecture d'un cluster PVE | `homelab@pve` (séparation des privilèges) | `PVEAuditor` sur `/` |
| écriture d'un hôte (sauvegardes de répertoires) | `host-<hôte>@pbs` | `DatastoreBackup` sur `/datastore/<chaque datastore>/Hosts` |

### Proxmox Backup Server

| Champ | Exemple |
|---|---|
| Adresse | `https://192.168.100.8:8007` |
| Empreinte du certificat | **Récupérer** lit celle que présente le PBS ; à comparer avec **Tableau de bord › Afficher l'empreinte** |
| Jeton | `homelab@pbs!monitor` (créé par la commande) |
| Image du client | `mathmath350/pbs-client:latest` (hôtes sans client installé, voir plus bas) |

**Adresse du PBS sur Tailscale** (optionnel, saisie à la main) : adresse que reçoivent les agents des hôtes du [réseau d'accès Tailscale](installation.md#réseau-daccès-lan-ou-tailscale), avec la même empreinte de certificat. Elle est vide par défaut : ces hôtes ne reçoivent alors aucune définition de sauvegarde, ils ne basculent jamais sur l'adresse du LAN.

Le fuseau proposé pour les sauvegardes de répertoires est celui du hub : variable `TZ` du compose (défaut `Europe/Paris`).

**Tester la connexion** liste les datastores visibles (avertissement si aucun : revoir les droits). Quand une adresse Tailscale est saisie, le test porte sur les deux adresses (même jeton, même empreinte) et affiche un résultat par adresse. Le hub relève le PBS toutes les 15 minutes, et aussitôt après une sauvegarde de répertoires réussie ; **Relever** sur la page Sauvegardes le fait tout de suite.

:::info Certificat épinglé
Les certificats du PBS et de Proxmox VE sont auto-signés : le hub n'accepte que celui dont l'empreinte est enregistrée, et la vérifie avant d'envoyer le jeton. Après un renouvellement du certificat, récupérer à nouveau l'empreinte. Sans empreinte, le certificat doit être valide pour les autorités du système.
:::

### Clusters Proxmox VE

**Ajouter** : un identifiant court (`vouille`, fixé à la création), un nom affiché, l'adresse d'un nœud (`https://192.168.100.241:8006`) et son empreinte. La commande du jeton demande l'identifiant et l'adresse : le jeton reçu enregistre le cluster et lance son relevé. Plusieurs clusters peuvent écrire sur le même PBS.

Toutes les 15 minutes, le hub lit pour chaque cluster :
- les guests (CT et VM, hors modèles) et les adresses MAC de leurs interfaces ;
- les jobs de sauvegarde (`/cluster/backup`) : planification, guests couverts (liste, « tous sauf », pool, nœud), stockage cible, actif ou non ;
- les stockages PBS du cluster : un stockage n'est retenu que s'il pointe vers le PBS suivi (même empreinte, à défaut même serveur), et il donne le **datastore et le namespace** où écrit le job — rien à configurer ;
- les dernières tâches vzdump de chaque nœud, et le résultat de chaque guest (lu dans le journal quand une tâche sauvegarde plusieurs guests) ;
- le fuseau horaire des nœuds : les planifications sont des heures de ce fuseau.

**Retirer** un cluster supprime ses guests, leurs liens et le rattachement automatique de leurs sauvegardes (les snapshots restent sur le PBS, orphelins).

## Lien hôte ↔ guest Proxmox

L'agent remonte les adresses MAC de ses interfaces ; le hub cherche le guest qui porte l'une d'elles, sur tous les clusters. Une correspondance **unique** lie l'hôte à son CT ou sa VM (badge `CT 171 · pve1` sur la carte Sauvegardes) ; une MAC présente sur plusieurs guests, ou un hôte qui en désigne plusieurs, ne lie rien. Rien n'est écrit sur Proxmox.

Les groupes que les jobs de ce guest écrivent sur le PBS (`<datastore>/<namespace>/ct|vm/<vmid>`) sont alors rattachés à l'hôte, sans action ; un job qui n'a encore rien écrit apparaît « jamais sauvegardée ». Un guest lié qu'aucun job actif ne couvre déclenche l'alerte « couvert par aucun job de sauvegarde Proxmox ». Les guests sans agent ne sont pas suivis : leurs sauvegardes restent orphelines. Les VM **Home Assistant OS** ont un agent, sous forme d'application Home Assistant (voir [Installation](installation.md#home-assistant-os)) : leurs sauvegardes se rattachent comme les autres.

## Sauvegardes de répertoires

Définies dans Homelab Manager et exécutées par l'agent avec `proxmox-backup-client`. Le hub les définit, l'agent les exécute, le PBS les confirme.

Depuis la fiche hôte, carte **Sauvegardes** › **+ Sauvegarde** (administrateurs) : la fenêtre « Sauvegardes lancées par l'agent » liste ses jobs (répertoires et [bases de données](#sauvegardes-de-bases-de-données)) avec, pour chacun, lancer, modifier et supprimer, et **Ajouter** pour un nouveau job ; elle montre aussi l'état du client PBS et le jeton. Un job existant se modifie aussi directement par le crayon de sa ligne (fiche hôte ou page Sauvegardes) :

1. **Client PBS.** L'icône de l'en-tête de la carte indique son état : paquet vert = client installé (APT), conteneur bleu = image Docker présente, paquet barré = absent. Sans client, la fenêtre propose les installations possibles sur cet hôte :
   - **Installer via APT** : dépôt `pbs-client` de Proxmox et paquet `proxmox-backup-client` (Debian bookworm / trixie, **amd64** uniquement) ;
   - **Installer via Docker** : téléchargement de l'image du client, publiée pour **amd64** uniquement (repo [pbs-client](https://github.com/Mamath2000/pbs-client)).

   L'installation est une tâche de l'agent (visible dans Activité). Un hôte en mode Docker peut passer au client APT, qui est alors préféré. Ailleurs (arm64, autre distribution), installer le client à la main : l'agent le détecte.
2. **Accès PBS** : le jeton propre à l'hôte, créé par la commande à usage unique. Il a `DatastoreBackup` sur le namespace `Hosts` de chaque datastore : il ne voit et ne modifie que les sauvegardes dont il est propriétaire, et ne peut pas écrire dans les namespaces de Proxmox VE.
3. **Ajouter** (bloqué tant qu'il n'y a ni client ni jeton) : type (**Répertoires**, **Base PostgreSQL**, **Base MongoDB** ; fixé à la création), nom, répertoires (une archive `.pxar` par répertoire, chemins absolus), exclusions, datastore, identifiant sur le PBS (groupe `host/<identifiant>`, fixé à la création), planification. Le namespace (`Hosts`) et le fuseau (celui du hub, variable `TZ`, fixé à la création du job) sont affichés sans être modifiables.

**Estimer la taille** (sous les exclusions, agent ≥ 0.3) : l'agent parcourt les répertoires du formulaire avec les exclusions saisies, **sans rien envoyer**, et affiche par répertoire la taille et le nombre de fichiers retenus, ce que les exclusions retirent et les 8 plus gros éléments exclus. Pour un job existant, la taille de son dernier snapshot sur le PBS est affichée à côté. Le résultat devient « à relancer » dès que les répertoires ou les exclusions changent ; l'estimation n'est jamais lancée automatiquement (elle lit l'arborescence de l'hôte, 3 minutes et 5 millions d'entrées au plus : au-delà, le chiffre est un minimum).
- `proxmox-backup-client` ne sait pas le faire (`--dry-run` ne parcourt rien) : l'agent applique **les règles du client, portées de son code** (crate `pathpatterns` et `pxar/create.rs`) — chemin testé relatif à la racine de l'archive ; motif sans `/` en tête valable à toute profondeur, avec `/` depuis la racine ; `*` et `?` ne traversent pas `/`, `**` si ; `/` final = répertoires seulement ; `!` ré-inclut ; le dernier motif qui correspond l'emporte ; un répertoire exclu n'est pas parcouru ; les fichiers `.pxarexclude` des répertoires sont pris en compte ; les autres systèmes de fichiers ne sont pas parcourus.
- Conformité vérifiée par les tests de l'agent : les assertions de `pathpatterns`, et des listes de référence produites par le vrai `pxar` sur une arborescence de test (`agent/testdata/estimate`, régénérées par `agent/testdata/estimate/regen.sh [hôte]` quand le client change de version).
- C'est la taille **brute** des fichiers (liens durs comptés une fois) : le PBS stocke moins (déduplication, compression), et la taille d'un snapshot affichée par le PBS inclut les métadonnées de l'archive.

**Rétention** : elle n'est pas choisie par job. C'est l'élagage du PBS qui s'applique (job d'élagage du namespace `Hosts` du datastore, ou options du datastore) ; le formulaire l'affiche sous le datastore (« Rétention (élagage du PBS, tous les jours à 21:00) : 10 quotidiennes · 3 mensuelles · 2 annuelles »), et avertit quand rien n'élague ce namespace. Choisir sa rétention revient à choisir son datastore ; elle se modifie dans le PBS (Datastore › Élagage et GC).

Planification : syntaxe des calendriers Proxmox — `03:00`, `sun 01:00`, `mon..fri 22:30`, `*/5` (toutes les 5 minutes), `daily`, `weekly`, `monthly`. Les dates et les secondes ne sont pas acceptées.

Fonctionnement :
- le hub envoie à l'agent toute la définition de l'hôte (jobs, jeton, empreinte, image) à chaque modification et à chaque connexion ; l'agent la garde sur disque (fichier lisible par root seulement ; sur Unraid, sur la clé USB) ;
- **l'agent planifie lui-même** : les sauvegardes continuent si le hub est arrêté ; une heure manquée pendant que l'agent était arrêté est **rattrapée** à son redémarrage ; un job ne rattrape jamais une heure antérieure à sa création ;
- le secret passe par l'environnement du client, jamais par sa ligne de commande ; en conteneur, les répertoires sont montés en lecture seule au même chemin ;
- chaque résultat est gardé par l'agent jusqu'à ce que le hub l'ait reçu : il apparaît dans **Activité** (« Sauvegarde · home », planifiée ou manuelle) avec le journal, et une erreur montre la ligne `Error:` du client (par ex. droits manquants sur un datastore) ;
- **Lancer** (sur la ligne de la sauvegarde, carte Sauvegardes) l'exécute tout de suite ; une sauvegarde peut durer : elle ne bloque pas les autres tâches de l'hôte.

Supprimer un job laisse ses snapshots sur le PBS (le groupe devient orphelin).

Après une sauvegarde réussie, le hub relit le PBS tout de suite, puis 2 et 10 minutes plus tard : sur un datastore qui vérifie les nouveaux snapshots (`verify-new`), la vérification se termine après la première relecture, et le snapshot resterait affiché « non vérifié » jusqu'au relevé suivant.

## Sauvegardes de bases de données

Un job de type **Base PostgreSQL** ou **Base MongoDB** est une sauvegarde de l'agent au même titre qu'une sauvegarde de répertoires (client PBS, jeton, datastore, identifiant, planification, rétention et suivi identiques), mais son contenu est le **dump de bases** : l'agent fait le dump dans un **répertoire de travail**, un sous-répertoire par dump, et ces sous-répertoires sont les archives du snapshot. Un tel job ne contient que ses dumps (ni répertoire ni exclusion). Les commandes sont **figées dans l'agent** (rien à installer sur l'hôte, aucune commande libre) : l'interface ne choisit que les paramètres.

| Type | Exécution | Archives (`<répertoire de travail>/<archive>`) |
|---|---|---|
| **PostgreSQL, par base** | `pg_dump -Fd -Z0` de chaque base choisie, plus `pg_dumpall --globals-only` (rôles et tablespaces, indispensables pour restaurer les droits) ; serveur **local**, en tant qu'utilisateur `postgres` (`runuser`) | `pg-globals`, `pg-<base>` |
| **PostgreSQL, cluster complet** | `pg_basebackup -Fp -Xstream -c fast` : copie physique du cluster avec ses WAL, restaurée à l'identique (extensions comprises, TimescaleDB…) ; même version majeure de PostgreSQL à la restauration | `pg-cluster` |
| **MongoDB** | `mongodump --db <base>` **dans le conteneur** (`docker exec`), puis copie hors du conteneur (`docker cp`) | `mongo-<base>` |

- **Dumps non compressés** (format répertoire, un fichier par table ou collection) : le PBS les déduplique d'un jour à l'autre et les compresse lui-même. Un dump compressé changerait entièrement chaque jour.
- Chaque sous-répertoire de dump est **vidé puis refait** à chaque exécution : jamais de mélange avec le dump de la veille.
- **Dump en échec** (base absente, serveur arrêté, conteneur introuvable…) : le job est en échec, rien n'est envoyé ; l'erreur et la sortie des commandes sont dans le journal (Activité).
- **Dumps gardés sur l'hôte** (0 à 30, défaut 1) : une fois l'envoi tenté, le dump part dans `<répertoire de travail>/history/<AAAAMMJJ-hhmmss>/` et seuls les N derniers sont gardés (restauration locale rapide, au prix de la place disque). **0** : le dump est supprimé une fois envoyé, et l'historique avec. Un dump en échec (incomplet) est toujours supprimé, sans toucher à l'historique.
- **Choix des bases** : le bouton **Lister les bases**, en bout de ligne du conteneur (MongoDB) ou du mode (PostgreSQL), demande à l'agent les bases du serveur avec leur taille ; un clic en ajoute ou en retire une du job (pas de saisie à la main). L'agent contrôle au passage les outils (`pg_dump`, `pg_basebackup`, `runuser`, ou le conteneur démarré et son `mongodump`) et la place libre du répertoire de travail, comparée à la taille des bases choisies. À la modification d'un job, la liste est demandée d'office ; une base choisie absente du serveur est signalée en rouge.
- **Identifiant sur le PBS** : proposé à partir de l'hôte, du type et des bases (`<hôte>-mongo-<base>`, `<hôte>-pg-<base1>-<base2>`, `<hôte>-pg-cluster`), tant qu'il n'est pas saisi à la main ; fixé à la création.
- **Listes** (fiche hôte, page Sauvegardes, fenêtre de l'agent) : badge du type, ce qui est dumpé et où, dumps gardés ou supprimés, et pour la dernière exécution la **taille de chaque base et de son dump**. Le filtre **Type** de la page Sauvegardes a une entrée « base de données ».
- **Répertoire de travail** : chemin absolu d'au moins deux niveaux, dédié aux dumps (défaut `/var/backups/homelab-agent`), jamais sous `/etc`, `/usr`, `/proc`… PostgreSQL : les dumps sont écrits par l'utilisateur `postgres`, qui doit pouvoir y accéder ; l'agent ajoute le droit de traversée pour « autres » (`x` seul : le contenu ne peut pas être listé) au répertoire de travail **et à chacun de ses parents** qui ne l'ont pas (ex. `/mnt/backup` en 700 → 701), et le note dans le journal du job.
- Restauration : depuis le PBS, ou depuis `history/` sur l'hôte ; `pg_restore -d <base> pg-<base>/` (après `psql -f pg-globals/globals.sql` sur un cluster neuf) ; cluster : le contenu de `pg-cluster/` devient le répertoire de données (serveur arrêté) ; MongoDB : `mongorestore --db <base> mongo-<base>/`.
- Il faut un agent **0.2** ou plus récent : pour un agent plus ancien, le job n'est pas envoyé (« pas encore appliquée par l'agent »). Le formulaire signale aussi un type inutilisable sur l'hôte (`pg_dump` introuvable, Docker absent).

## Plugin Nextcloud AIO

Sauvegarde complète d'une instance **Nextcloud All-in-One** : base, configuration et données de chaque utilisateur, chacune dans le datastore choisi. Le plugin est propre à ce type d'installation : il n'apparaît que si le hub a `BACKUP_NEXTCLOUD_AIO=true` (voir [Configuration](configuration.md)) **et** que l'agent de l'hôte (0.4 ou plus récent) trouve l'instance. Bouton **Nextcloud** de la carte Sauvegardes de l'hôte.

**Détection** : par l'**image** des conteneurs qui tournent (`.Config.Image`, référence gardée même quand le tag `latest` a bougé depuis), pas par leur nom : `nextcloud/all-in-one` (mastercontainer), `nextcloud-releases/aio-nextcloud`, `nextcloud-releases/aio-postgresql`, quel que soit le registre. Le reste est demandé à Nextcloud et à Docker à chaque exécution, rien n'est figé dans le job :

| Élément | Source |
|---|---|
| base, répertoire de données, instance | `occ config:system:get dbname / datadirectory / instanceid` (en `www-data`) |
| chemins sur l'hôte | montages du conteneur Nextcloud (`docker inspect`) : répertoire de données, volume `/var/www/html` |
| superutilisateur de la base | `POSTGRES_USER` du conteneur base (socket local en `trust`) |
| fichiers compose | labels compose du mastercontainer |
| utilisateurs | `occ user:list` ; répertoire `<données>/<id>` |

**Fenêtre du plugin** : l'agent relit l'instance à l'ouverture ; une ligne pour la **base**, une pour la **configuration**, une par **utilisateur**, chacune avec son datastore (« non sauvegardé » par défaut : aucun datastore n'est proposé d'office). Communs à tous les jobs : répertoire de travail, planification (l'agent enchaîne les jobs, un à la fois), dumps gardés sur l'hôte, activé. Un utilisateur sans répertoire (jamais connecté) ne peut pas être coché ; un utilisateur présent mais non sauvegardé est signalé sous le tableau.

**Jobs générés** (namespace `Hosts`, comme les autres jobs de l'agent) :

| Ligne | Job | Groupe PBS | Archives |
|---|---|---|---|
| Base | `Nextcloud · base` | `host/nextcloud-db` | `pg-globals` (`pg_dumpall --globals-only`), `pg-nextcloud` (`pg_dump -Fc -Z0`, format custom non compressé), lancés **dans le conteneur base** (ses outils, même version majeure) ; son système de fichiers est en lecture seule (AIO) : le dump sort sur la sortie standard et l'agent l'écrit sur l'hôte |
| Configuration | `Nextcloud · configuration` | `host/nextcloud-config` | `nc-config` : `config/` du volume, `compose/` (fichiers du mastercontainer), `data/` (fichiers à la racine du répertoire de données, `appdata_<instanceid>` **sans** `preview`, `appstore`, `js`), `discovery.json` (ce que l'agent a trouvé) — copie `cp -a` (propriétaires et droits gardés) |
| Utilisateur | `Nextcloud · <id>` | `host/nextcloud-user-<id>` | `data` : le répertoire de l'utilisateur |

- Base et configuration sont préparées dans `<répertoire de travail>/database` et `/config` (historique séparé, mêmes règles que les [sauvegardes de bases](#sauvegardes-de-bases-de-données)). Le répertoire de travail est sur l'hôte : l'exclure des autres sauvegardes du même disque.
- **Verrouillés** : un job généré ne se modifie ni ne se supprime depuis la carte Sauvegardes ou la page Sauvegardes ; **Lancer** reste possible. Décocher un utilisateur supprime son job, **Supprimer le plugin** supprime tous les jobs générés ; les snapshots restent sur le PBS (groupes orphelins).
- Un groupe déjà écrit par un autre job (par ex. un job de répertoires fait à la main pour un utilisateur) bloque l'enregistrement : supprimer ou renommer ce job d'abord.
- **Cohérence** : base et données ne sont pas figées ensemble (pas de mode maintenance). Après une restauration, `occ files:scan --all` remet la base en accord avec les fichiers.
- Restauration de la base : `pg_restore -d <base> pg-nextcloud/<base>.dump` (parallélisable avec `-j`), après `psql -f pg-globals/globals.sql` sur une instance neuve.
- Sans `BACKUP_NEXTCLOUD_AIO`, les jobs déjà générés continuent de tourner ; seule la fenêtre du plugin disparaît.

## Sauvegardes Home Assistant

L'agent des hôtes Home Assistant OS (application `homelab_agent`, voir [Installation](installation.md#home-assistant-os)) lit toutes les 15 minutes, **en lecture seule**, les sauvegardes de Home Assistant Core par son API WebSocket (`backup/agents/info`, `backup/info`, `backup/config/info`, `get_config` pour le fuseau). L'application déclare `homeassistant_api` : seule l'API de Core voit les destinations apportées par des intégrations (SFTP, Google Drive, partage réseau…) ; Supervisor ne voit que le stockage local. Le mot de passe des sauvegardes n'est ni gardé ni envoyé.

- **Une ligne par destination** (`haos/<hôte>/<destination>`, store « Home Assistant ») : stockage local et chaque emplacement d'intégration qui est une destination des sauvegardes automatiques ou porte des sauvegardes. Un emplacement inutilisé (Home Assistant Cloud non configuré…) est ignoré.
- **Planification** : celle des sauvegardes automatiques de HA (récurrence, jours, heure, fuseau de HA) ; le retard se calcule comme pour une planification Proxmox.
- **Échec** : la destination figure dans les échecs de la dernière sauvegarde automatique, ou la sauvegarde automatique entière a échoué ; l'erreur de la destination est affichée sur la ligne.
- **Désactivée** : la destination ne reçoit pas les sauvegardes automatiques (sauf seuil manuel).
- Une destination illisible garde son historique ; une destination retirée dans Home Assistant disparaît du hub.

La capacité `ha_backups` n'apparaît sur l'hôte qu'après une première lecture réussie ; sinon le journal de l'application en donne la raison et l'agent réessaie au cycle suivant.

## Sauvegardes externes : rattachement manuel

Pour les sauvegardes faites ailleurs (`backup_pbs_scripts`, ElkarBackup…) :
- **Fiche hôte**, carte **Sauvegardes** › **Rattacher** : la fenêtre liste les sauvegardes externes de l'hôte et celles du PBS rattachées à aucun hôte ; cocher celles qui lui appartiennent (administrateurs).
- **Détacher** : l'icône de la ligne. **Page Sauvegardes**, colonne **Hôte** : déplacer ou détacher.
- **Orphelines** (page Sauvegardes) : les sauvegardes du PBS rattachées à aucun hôte ; une orpheline disparue du PBS peut y être oubliée.

Les sauvegardes image PVE et répertoires ne se rattachent ni ne se détachent à la main.

## Retard

| Source du seuil | Règle |
|---|---|
| **manuel** | valeur choisie dans la colonne Seuil (26 h, 2 jours, 8 jours, 32 jours) |
| **planification** | image PVE, répertoires et Home Assistant : en retard si aucun snapshot depuis la dernière heure prévue, 2 h de marge comprises ; seuil affiché = une période + 2 h |
| **appris** | 1,5 × l'intervalle médian entre les derniers snapshots (au moins 4), 2 h de marge minimum |
| **rétention** | même calcul avec la période la plus fine gardée par l'élagage du PBS (`keep-daily` → quotidienne…) |
| **aucun** | aucune des sources précédentes (sauvegarde externe récente, moins de 4 snapshots, namespace sans élagage) : pas de seuil, **jamais en retard** ni d'alerte |

Une planification que le hub ne sait pas lire retombe sur le rythme appris.

| État | Signification |
|---|---|
| à jour | snapshot présent pour la dernière échéance |
| en retard | pas de snapshot depuis l'échéance (ou « jamais sauvegardée ») |
| dernière exécution en échec | la dernière tâche vzdump du guest, ou la dernière exécution de l'agent, a échoué après le dernier snapshot ; Home Assistant : la dernière sauvegarde automatique a échoué pour cette destination |
| job désactivé | tous les jobs qui écrivent cette sauvegarde sont désactivés ; Home Assistant : la destination ne reçoit pas les sauvegardes automatiques |
| pas encore appliquée par l'agent | l'agent n'a pas encore reçu la définition actuelle (hors ligne, client absent…) |
| vérification en échec | la dernière vérification (verify job du PBS) a échoué |
| disparue du PBS | le groupe n'existe plus sur le PBS |

## Interface

- **Page Sauvegardes** : compteurs et espace des datastores ; une ligne par sauvegarde suivie : nom (celui du job pour une sauvegarde de répertoires), **type**, hôte, 30 derniers jours, dernière, taille, vérification, état, seuil. Filtres : en retard / échec, **type**, hôte, recherche.
- **Fiche hôte**, carte **Sauvegardes** : icône du client PBS, guest Proxmox lié, alerte « non couvert », chaque sauvegarde avec son type, son état, sa planification ou son rythme et sa frise des 30 derniers jours ; boutons **+ Sauvegarde**, **Rattacher**, et sur chaque ligne d'un job de l'agent le crayon (modifier) et **Lancer**.
- **Snapshots** : l'icône en forme de couches, sur chaque ligne (page Sauvegardes, à côté du nom ; fiche hôte, à droite), ouvre la liste des snapshots de la sauvegarde, du plus récent au plus ancien. Elle affiche d'abord les 4 derniers, puis **Voir tout** déplie l'historique gardé par le hub (30 au plus ; la fenêtre indique quand le PBS en a davantage). Colonnes :
  - date d'exécution (relative au survol) ;
  - taille ;
  - vérification : vérifiée / en échec / non vérifiée ;
  - note : commentaire du snapshot, nom du guest pour un vzdump.

  C'est l'historique vu au dernier relevé, sans lecture du PBS en direct.
- **Liste des hôtes** : badge « sauvegarde en retard / en échec / désactivée ». **Tableau de bord** : moitié basse du carré de chaque hôte, chiffres clés et liste « Sauvegardes à surveiller ».

## Home Assistant

- Par hôte ayant des sauvegardes, un sous-appareil **Sauvegardes** : date de la dernière sauvegarde (détail des groupes en attributs), nombre en retard, alertes.
- Alertes : en retard / jamais sauvegardée, dernière exécution en échec, job désactivé, pas encore appliquée par l'agent, vérification en échec, disparue du PBS, guest non couvert. Elles remontent à l'hôte puis à Homelab Manager. Pas d'alerte pour les orphelines, ni de retard pour un hôte itinérant absent.
- Sur Homelab Manager : **Sauvegardes en retard** et l'occupation de chaque datastore.

## Rôles

Tous les rôles voient les sauvegardes. Les opérateurs peuvent relever et **lancer** une sauvegarde de répertoires. Seuls les administrateurs règlent les connexions (PBS, clusters), les jetons, les jobs, l'installation du client, le rattachement et le seuil propre à une sauvegarde.
