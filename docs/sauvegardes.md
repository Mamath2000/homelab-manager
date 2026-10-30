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
| **externe** | faite hors Homelab Manager (script ou cron maison, outil tiers…) | à la main, depuis la fiche hôte | le rythme appris de ses snapshots |
| **Home Assistant** | sauvegarde faite par Home Assistant (Paramètres › Système › Sauvegardes), une ligne par destination | automatique : l'agent HAOS de l'hôte | la planification des sauvegardes automatiques de HA |

Le PBS reste la référence : un snapshot n'est « fait » que lorsqu'il est sur le PBS. Exception : les sauvegardes Home Assistant, dont la référence est Home Assistant lui-même.

## Mise en place

Paramètres › **Sauvegardes** : un bloc **Proxmox Backup Server** ; les clusters Proxmox VE ne sont plus ici mais des [rôles](roles.md) (**Paramètres › Rôles**, le bloc d'ici y renvoie par un lien). Le PBS et un cluster ont le même modèle : une ligne par serveur (adresse, état du dernier relevé, jeton), et une fenêtre d'édition (format 16:9) qui se remplit en quatre étapes, de gauche à droite : **1. Hôte** (l'hôte du PBS ou un nœud du cluster, et **Détecter**), **2. Détection** (ce que donne l'agent, affiché en texte), **3. Jeton(s)** et **4. Test de connexion**. L'étape à faire est encadrée et son bouton mis en avant ; une étape faite est cochée, les suivantes restent grisées tant qu'elle ne l'est pas. Le pied de fenêtre garde les réglages : image du client pour le PBS principal, heure de départ des copies pour le PBS de secours, identifiant et nom pour un cluster Proxmox VE. Il n'y a pas de case « suivre » : un serveur déclaré avec son jeton est **connecté** et relevé ; pour l'arrêter, on le [déconnecte](#déconnecter-un-pbs-ou-un-cluster).

Aucun jeton ne se recopie à la main ni ne se crée par une commande à coller : **l'agent** de l'hôte du PBS, ou d'un nœud du cluster Proxmox VE, les crée. Son enrôlement est le prérequis à toute configuration.

### Jetons du PBS : créés par l'agent du PBS

Les jetons ne se recopient jamais à la main, et il n'y a rien à coller sur le PBS : **l'agent de l'hôte du PBS** les crée, que le PBS soit installé sur l'hôte ou lancé dans un conteneur Docker.

1. **Relier le PBS à son agent** (fenêtre du PBS, étape **1. Hôte**, à faire en premier : sans agent, rien n'est configurable) : choisir l'**hôte du PBS** parmi les agents qui savent administrer un PBS, puis **Détecter**. L'agent cherche `proxmox-backup-manager` sur l'hôte, puis dans les conteneurs lancés, et renvoie le mode (installé ou conteneur, avec son nom), la version, les datastores, le port et l'empreinte du certificat. L'**adresse** (première adresse privée de l'hôte), l'**adresse Tailscale** (son IP `100.x`, même port) et l'**empreinte** sont remplies par l'agent et ne se saisissent pas : pour les modifier, relancer **Détecter** (par exemple après un changement d'IP). Un conteneur dont le port 8007 n'est pas publié n'est pas joignable depuis le réseau : l'adresse reste vide, publier le port puis relancer **Détecter**. Le conteneur trouvé est celui qu'utilisent ensuite toutes les créations de jetons.
2. **Créer le jeton** : l'**identifiant** (`utilisateur@pbs!nom`) est pré-rempli et modifiable. L'agent crée l'utilisateur s'il manque, puis le jeton, et donne chaque droit à l'utilisateur **et** au jeton (les droits d'un jeton PBS sont l'intersection des siens et de ceux de son utilisateur). Le secret va de l'agent au hub par la connexion chiffrée de l'agent : **jamais affiché, jamais écrit dans un journal**. Le jeton de supervision et le lien vers l'agent sont enregistrés aussitôt.
3. Les **jetons des hôtes** se créent ensuite depuis la fiche de chaque hôte (**Accès PBS**), par le même agent.

- Jeton **déjà existant** : ses droits sont remis à ceux décidés par le hub — les droits manquants sont ajoutés, ceux **du jeton** qui ne sont plus prévus lui sont retirés (ceux de l'utilisateur restent : il peut porter d'autres jetons du hub). Le secret d'un jeton n'est lisible qu'à sa création : si le hub détient celui de ce jeton, il le garde ; sinon (base perdue, jeton créé à la main, autre PBS sous le même nom), l'agent **supprime et recrée le jeton** — nouveau secret, l'ancien ne fonctionne plus. Le message de fin l'indique (« recréé »). Pour le jeton de supervision et celui du PBS de secours, un secret détenu pour un autre hôte (ou un autre conteneur) ne compte pas : changer l'hôte du PBS recrée le jeton.
- Si la création échoue après celle du jeton (droit refusé, PBS qui ne répond plus), l'agent supprime le jeton : un nouvel essai repart de zéro.
- L'agent n'accepte que les rôles et chemins prévus (`DatastoreAudit`, `DatastoreBackup`, `DatastoreReader` sous `/datastore`, `Audit` sous `/system/tasks`, `RemoteAdmin` sous `/remote`), jamais `/`.
- Un jeton de supervision créé avant l'ajout des statistiques n'a pas le droit `Audit` : relancer l'étape **Jeton** du PBS (Paramètres › Sauvegardes) pour le lui donner (le secret est conservé).
- L'agent du PBS doit être à jour (capacité « pbs ») et en ligne ; pour révoquer un jeton (déconnexion, retrait du jeton d'un hôte), capacité « pbs_token_delete ».

:::note PBS en conteneur
Le PBS lancé dans Docker n'a été testé qu'avec l'image `ayufan/proxmox-backup-server`. Si le conteneur est en `network_mode: host`, le port est celui sur lequel le PBS écoute, lu par l'agent (`ss`, 8007 à défaut) ; sinon, le port publié pour 8007. Un conteneur renommé ou recréé sous un autre nom : refaire **Détecter**.
:::

#### Portée de chaque jeton

| Jeton | Utilisateur (défaut) | Rôle et chemin | Permet | Ne permet pas |
|---|---|---|---|---|
| supervision du PBS | `homelab@pbs!monitor` | `DatastoreAudit` sur `/datastore` + `Audit` sur `/system/tasks` | lister les datastores, leur occupation, les groupes et snapshots, les tâches de prune ; lire la liste et le journal des tâches de sauvegarde ([volume transféré et durée](#volume-transféré-et-durée)) | lire le contenu d'une sauvegarde, écrire ou supprimer quoi que ce soit |
| écriture d'un hôte | `host-<hôte>@pbs!backup` | `DatastoreBackup` sur `/datastore/<chaque datastore>/Hosts` | créer des sauvegardes dans le namespace `Hosts`, voir et relire **ses propres** groupes | voir ou relire les groupes des autres hôtes, écrire hors de `Hosts` (namespaces de Proxmox VE) |
| lecteur (PBS principal) | `homelab@pbs!reader` | `DatastoreReader` sur `/datastore` | lire toutes les sauvegardes du PBS principal : c'est avec lui que le [PBS de secours](#copie-déportée-pbs-de-secours) les tire | écrire, supprimer, modifier quoi que ce soit |
| montage (volatil) | `homelab-mount@pbs!m<horodatage>` | `DatastoreReader` sur `/datastore/<datastore>/<namespace du groupe>` | lire les sauvegardes de ce namespace, le temps d'un [montage](#monter-une-sauvegarde-lecture-seule) : créé au montage, révoqué au démontage | écrire, supprimer, lire hors de ce namespace ; il n'est jamais conservé par le hub |
| hub sur le PBS de secours | `homelab@pbs!hub` | `DatastoreBackup` + `DatastoreAudit` sur `/datastore/<datastore cible>`, `RemoteAdmin` sur `/remote` | déclarer l'entrée remote et les sync jobs (dont il est propriétaire), lister les copies et leur état | **supprimer un snapshot**, activer `remove-vanished`, créer un namespace (ni `Datastore.Prune` ni `Datastore.Modify`), toucher aux autres datastores |

Le chemin `{store}` est développé sur chaque datastore présent au moment de la création : après l'ajout d'un datastore, recréer le jeton de l'hôte (le secret est conservé) pour l'étendre.

### Jeton de Proxmox VE : créé par l'agent d'un nœud

Rien à coller sur le cluster : **l'agent d'un nœud** (n'importe lequel, les nœuds partagent leurs utilisateurs) crée le jeton du hub.

1. **Nœud du cluster** (étape **1**) : choisir l'hôte parmi les agents qui savent administrer Proxmox VE (capacité « pve » : `pveum` présent), puis **Détecter**. L'agent renvoie la version, le nom du cluster (le nœud seul pour un Proxmox VE sans cluster), les nœuds, les interfaces du nœud avec leurs IPv4, et l'empreinte du certificat que présente `pveproxy` (`pveproxy-ssl.pem` s'il existe — certificat personnalisé ou ACME —, sinon `pve-ssl.pem`). L'identifiant et le nom du cluster sont pré-remplis avec le nom du cluster. Un cluster ne se déclare qu'**une fois** : l'agent d'un nœud annonce le nom de son cluster (capacité `pve_cluster:<nom>`), les nœuds d'un cluster déjà suivi ne sont plus proposés, et le hub refuse (409) de créer le jeton ou d'enregistrer une entrée qui passerait par un nœud d'un cluster déjà suivi (sinon les guests seraient listés deux fois et leurs adresses MAC deviendraient ambiguës). Un agent pas encore à jour n'annonce pas son cluster : il n'est ni filtré ni bloqué.
2. **Détection** (étape **2**) : choisir l'**interface** par laquelle le hub joint l'API (un nœud a souvent plusieurs ponts : réseau de gestion, LAN, VLAN ; l'interface de la route par défaut est signalée, ce n'est pas forcément celle que le hub joint). L'adresse est `https://<IP de l'interface>:8006`. L'empreinte est celle du **nœud** choisi : le hub n'interroge que lui.
3. **Créer le jeton** (étape **3**) : l'identifiant (`utilisateur@pve!nom`, défaut `homelab@pve!monitor`) est pré-rempli et modifiable. L'agent crée l'utilisateur s'il manque, puis le jeton avec **séparation des privilèges**, et donne le rôle à l'utilisateur **et** au jeton (les droits effectifs du jeton sont l'intersection des deux). Le secret va de l'agent au hub par la connexion chiffrée de l'agent : **jamais affiché, jamais écrit dans un journal**. Le cluster (créé s'il est nouveau), son jeton et le nœud sont enregistrés aussitôt, et le relevé est lancé.
4. **Tester la connexion** (étape **4**) : lit l'état du cluster et ses jobs de sauvegarde avec le jeton enregistré.

Jeton déjà existant, rollback en cas d'échec et retrait des droits en trop **du jeton** : comme pour le PBS (voir plus haut). L'agent n'accepte que `PVEAuditor` sur `/`.

#### Portée du jeton

| Jeton | Utilisateur (défaut) | Rôle et chemin | Permet | Ne permet pas |
|---|---|---|---|---|
| lecture d'un cluster PVE | `homelab@pve!monitor` (séparation des privilèges) | `PVEAuditor` sur `/` (propagé) | lire la configuration et l'état : nœuds, guests (dont leurs adresses MAC), stockages et la liste de leur contenu, jobs de sauvegarde, tâches et leurs journaux, pools, fuseau horaire | démarrer, arrêter, migrer, modifier ou supprimer un guest ; ouvrir une console ; lancer ou restaurer une sauvegarde ; lire le contenu d'un disque ou d'une sauvegarde ; modifier les utilisateurs, les droits ou la configuration du cluster |

`PVEAuditor` regroupe les privilèges `*.Audit` (lecture seule). Le hub n'utilise que les lectures listées dans [Clusters Proxmox VE](#clusters-proxmox-ve) ; un rôle plus étroit (sans `Sys.Audit`, ou limité à certains chemins) n'a pas été retenu : les tâches et les jobs de sauvegarde se lisent au niveau du nœud et du cluster.

### Proxmox Backup Server

| Champ | Exemple |
|---|---|
| Adresse | `https://192.168.100.8:8007` |
| Empreinte du certificat | **Récupérer** lit celle que présente le PBS ; à comparer avec **Tableau de bord › Afficher l'empreinte** |
| Hôte du PBS | l'hôte dont l'agent administre le PBS (**Détecter** : PBS installé ou conteneur) |
| Jeton | `homelab@pbs!monitor` (créé par l'agent du PBS) |
| Image du client | `mathmath350/pbs-client:latest` (hôtes sans client installé, voir plus bas) |

**Adresse du PBS sur Tailscale** (détectée avec l'IP Tailscale de l'hôte du PBS ; saisie à la main seulement tant que le PBS n'est pas relié à son agent) : adresse que reçoivent les agents des hôtes du [réseau d'accès Tailscale](installation.md#réseau-daccès-lan-ou-tailscale), avec la même empreinte de certificat. Elle est vide par défaut : ces hôtes ne reçoivent alors aucune définition de sauvegarde, ils ne basculent jamais sur l'adresse du LAN.

Le fuseau proposé pour les sauvegardes de répertoires est celui du hub : variable `TZ` du compose (défaut `Europe/Paris`).

**Tester la connexion** (étape 4) liste les datastores visibles (avertissement si aucun : revoir les droits). Le test porte sur l'adresse du LAN seulement : l'adresse Tailscale n'est pas essayée, le hub ne recevant que sur le tailnet (conteneur `tailscale` en entrée seulement), et le test l'indique sur une ligne à part (« non testable depuis le hub »), pas comme une erreur. Les agents des hôtes Tailscale joignent le PBS par leur propre Tailscale. Le hub relève le PBS toutes les 15 minutes, et aussitôt après une sauvegarde de répertoires réussie ; **Relever** sur la page Sauvegardes le fait tout de suite, et relit aussi le PBS de secours et, par leur agent, les sauvegardes des hôtes Home Assistant OS.

:::info Certificat épinglé
Les certificats du PBS et de Proxmox VE sont auto-signés : le hub n'accepte que celui dont l'empreinte est enregistrée, et la vérifie avant d'envoyer le jeton. Après un renouvellement du certificat, relancer **Détecter** pour relire l'empreinte. Sans empreinte, le certificat doit être valide pour les autorités du système.
:::

### Clusters Proxmox VE

Un cluster est un rôle `Cluster Proxmox VE` ([Rôles du hub](roles.md)), porté par le nœud choisi à l'étape **1. Hôte** ; il ne peut changer de porteur que pour un autre nœud **du même cluster**, et un nœud porteur hors ligne met seulement le relevé en erreur (alerte, rien n'est déplacé tout seul).

**Ajouter** : la fenêtre en quatre étapes décrite dans [Jeton de Proxmox VE](#jeton-de-proxmox-ve--créé-par-lagent-dun-nœud) ; l'identifiant court (`vouille`, pré-rempli avec le nom du cluster) est fixé à la création du jeton. Plusieurs clusters peuvent écrire sur le même PBS.

Toutes les 15 minutes, le hub lit pour chaque cluster :
- les nœuds, les guests (CT et VM, hors modèles) avec leur état, et les adresses MAC de leurs interfaces (inventaire : voir [Proxmox VE](proxmox-ve.md)) ;
- les jobs de sauvegarde (`/cluster/backup`) : planification, guests couverts (liste, « tous sauf », pool, nœud), stockage cible, actif ou non ;
- les stockages PBS du cluster : un stockage n'est retenu que s'il pointe vers le PBS suivi (même empreinte, à défaut même serveur), et il donne le **datastore et le namespace** où écrit le job — rien à configurer ;
- les dernières tâches vzdump de chaque nœud, et le résultat de chaque guest **par stockage cible** (lu dans le journal de la tâche) ;
- le contenu des stockages cibles autres que le PBS suivi (archives vzdump), quand le jeton peut les lister ;
- le fuseau horaire des nœuds : les planifications sont des heures de ce fuseau.

**Retirer** un cluster (confirmation) révoque d'abord son jeton par l'agent du nœud relié, puis supprime ses guests, leurs liens et le rattachement automatique de leurs sauvegardes (les snapshots restent sur le PBS, orphelins). Voir [Déconnecter un PBS ou un cluster](#déconnecter-un-pbs-ou-un-cluster).

## Copie déportée (PBS de secours)

Un second PBS, distant, garde une copie des sauvegardes choisies **une à une** (la place y est comptée : on ne copie pas tout). Il **tire** les sauvegardes du PBS principal : un PBS principal compromis ne peut pas effacer les copies, le hub non plus. Contrepartie assumée : le PBS de secours détient un jeton qui lit tout le PBS principal.

### Mise en place

Paramètres › Sauvegardes › **PBS de secours (copie déportée)** :

1. **Hôte du PBS** et **Détecter**, comme pour le PBS principal (PBS installé ou en conteneur) : adresse, adresse Tailscale et empreinte remplies par l'agent, datastores proposés.
2. **Datastore cible**, puis **Créer le jeton** du hub sur le PBS de secours (droits sur ce datastore seulement).
3. **Jeton lecteur sur le PBS principal**, créé par l'agent du PBS principal (qui doit donc être relié).
4. **Tester la connexion** (datastore visible, namespaces existants), puis, en pied de fenêtre, régler le **départ des copies** quotidiennes (voir plus bas) et **Enregistrer**. Le PBS de secours est connecté dès que son adresse, son datastore cible et les deux jetons sont là.
5. **Namespaces du datastore cible** : ceux des sauvegardes à copier doivent exister sur le PBS de secours, avec les mêmes noms que sur le PBS principal (`Hosts`, `Vouille`, `Jarsay`…), et le jeton du hub n'a pas le droit de les créer. Inutile de les préparer d'avance : dès qu'on active la copie d'une sauvegarde, l'interface vérifie et, s'il manque, donne la commande à copier dans un shell du PBS de secours (`proxmox-backup-client namespace create <ns> --repository root@pam@localhost:<datastore>`, parents d'abord), puis **Revérifier**.

Le hub déclare lui-même sur le PBS de secours l'entrée **remote `hlm-main`** (adresse et empreinte du PBS principal, jeton lecteur) ; elle est réécrite quand l'adresse, l'empreinte ou le jeton lecteur changent.

### Un sync job par datastore et namespace

Les sauvegardes copiées d'un même datastore et d'un même namespace du PBS principal partagent **un sync job** sur le PBS de secours, nommé `hlm-<datastore>[-<namespace>]` (`hlm-ds0-Hosts`, `hlm-ds1` pour la racine, `/` d'un namespace imbriqué remplacé par `.` ; une empreinte au-delà de 32 caractères). Son **filtre de groupe** liste exactement les sauvegardes choisies : activer la copie d'une sauvegarde y ajoute son groupe, la désactiver l'en retire (le job disparaît avec la dernière). Le hub ne touche jamais aux autres jobs ni à une autre entrée remote.

Pourquoi pas un job par datastore entier : le filtre de groupe de PBS ne regarde que `type/id`, pas le namespace (`group:ct/105` prendrait le CT 105 de `Vouille` **et** celui de `Jarsay`), et un job récursif tente de créer côté cible chaque namespace source manquant, ce que le jeton du hub n'a pas le droit de faire (le job finirait en erreur).

| Réglage du job | Valeur |
|---|---|
| source | remote `hlm-main`, datastore et namespace |
| cible | datastore cible, **même namespace** que la source (sans niveau par datastore : une sauvegarde déplacée d'un datastore à l'autre reste un seul groupe) |
| filtre | les groupes choisis (`group:<type>/<id>`), jamais vide ; profondeur 0 |
| `transfer-last` | **1** : chaque copie envoie le dernier snapshot ; le PBS de secours garde les siens selon sa propre rétention (pas de miroir du groupe) |
| `verified-only` | **oui** : seuls les snapshots vérifiés sont copiés (le PBS principal vérifie chaque nouvelle sauvegarde, `verify-new`). Le filtre passe **avant** `transfer-last` : c'est le dernier snapshot *vérifié* qui part ; un snapshot pas encore vérifié attend la série suivante |
| `resync-corrupt` | **oui** : une copie dont la vérification a échoué sur le PBS de secours est renvoyée |
| `worker-threads` | **1** groupe à la fois |
| `remove-vanished` | non : une sauvegarde purgée du principal reste sur le PBS de secours |
| `rate-in` | aucune limite : le PBS de secours (N40L) est limité par son processeur, pas par la fibre |
| propriétaire | le jeton du hub |
| planification | **aucune** : c'est l'agent du PBS de secours qui lance les jobs (ci-dessous) |

- Le hub **réconcilie** les jobs à chaque changement et à chaque relevé : il crée ceux qui manquent, remet en état ceux qui diffèrent (un filtre ou une option modifiés à la main sont rétablis) et supprime les jobs `hlm-*` qui ne sont plus voulus. Les copies déjà faites restent : **les purges sont celles du PBS de secours** (rétention, verify et GC s'y règlent).
- **Copiable ?** Vérifié dès qu'on active la copie (case de l'onglet, détail d'une sauvegarde non copiée), puis à l'enregistrement : « Copiable », ou le motif — sauvegarde Home Assistant (pas sur le PBS) ou jamais écrite ; PBS de secours non configuré ; namespace cible absent (commande à copier, voir ci-dessus) ; même groupe (namespace + `type/id`) déjà copié depuis un autre datastore. Les sauvegardes de guests (vzdump) se copient comme les autres.
- Sauvegarde disparue du PBS principal : son groupe reste dans le filtre (sans effet) et la copie est conservée ; il en sort quand la sauvegarde est oubliée.
- **Copier maintenant** (exceptionnel, opérateurs compris) : bouton du détail d'une sauvegarde copiée. Le hub crée un job de sync temporaire `hlm-adhoc-<hash>` (mêmes options que le job du datastore, filtre limité à cette sauvegarde : le dernier snapshot **vérifié**), le lance, le suit comme une copie normale (console ou Activité, déclencheur « manuel ») et le supprime à la fin, réussite ou échec ; les jobs restés (hub redémarré) sont nettoyés au relevé suivant. L'agent n'est pas concerné : la copie peut tourner **en parallèle** de la série quotidienne (autre datastore ou namespace) ; refusée pour la même sauvegarde déjà en cours. Bouton désactivé (avec la raison) quand la copie est déjà à jour ou qu'aucun snapshot vérifié n'est à copier ; le job du datastore trouvera ensuite le snapshot déjà présent. **Retirer de la copie** : bouton du détail d'une sauvegarde copiée (administrateurs), direct ; la sauvegarde sort du filtre de son job, les snapshots déjà copiés restent.
- **Migration** (avant #186 : un job `hlm-<empreinte>` par sauvegarde, file d'attente de l'agent) : au premier relevé, les anciens jobs sont supprimés et remplacés ; le hub efface les réglages de file, l'agent son fichier `offsite.json`.

API : `PUT /api/backups/<id>/offsite` (`enabled`), `GET /api/backups/<id>/offsite/check` (copiable, namespace à créer et commandes), `POST /api/backups/<id>/offsite/run` (copie immédiate ; rend l'UPID de la tâche et le job qui la suit) ; le DTO de chaque sauvegarde porte `offsite`, son état et la copie en cours, et `GET /api/backups` le PBS de secours (hôte, datastore, occupation, état de la série) pour tous les profils.

### Copies quotidiennes : l'agent du PBS de secours enchaîne les jobs

PBS n'a pas de limite globale de jobs simultanés, et des jobs planifiés à la même heure partent tous ensemble : sur un PBS de secours modeste, derrière un VPN, c'est la congestion. Les sync jobs `hlm-*` n'ont donc **pas de planification** ; l'**agent du PBS de secours** (celui choisi à la mise en place, capacité `offsite_series`) les lance. Le hub n'est pas dans la chaîne : il pousse la définition à l'agent (liste des jobs, heure de départ, fuseau ; à sa connexion et à chaque changement), affiche l'état et alerte.

- Chaque jour à l'**heure de départ** (**04:00** par défaut : les sauvegardes principales commencent à 02:30 et sont vérifiées dans la foulée), l'agent lance les jobs **l'un après l'autre** : le suivant part quand plus aucune tâche de synchronisation ne tourne sur le PBS de secours (celles lancées à la main ou par un autre job comptent). Un job déjà en cours quand vient son tour (lancé depuis le hub) est sauté ; un lancement refusé est sauté et signalé.
- La définition et la série en cours sont gardées par l'agent (`/var/lib/homelab-agent/offsite-series.json`) : **les copies continuent quand le hub est arrêté**, et un redémarrage de l'agent reprend la série. Agent arrêté à l'heure de départ : la série part à son retour, le même jour. À la première définition reçue après l'heure de départ, la série attend le lendemain.
- **Rejeu après échec** : une fois la série du jour terminée et le délai du réglage **Rejeu après échec (h)** écoulé depuis le démarrage effectif de la série (4 h par défaut), l'agent relit l'état des jobs (`/admin/sync` : dernier état et fin du dernier run) et relance, **une seule fois dans la journée**, ceux dont le dernier run n'a pas abouti (erreur) ou qui n'ont pas tourné depuis le démarrage de la série (lancement refusé). Un avertissement compte comme un succès : une série entièrement réussie n'est pas rejouée. Le rejeu suit les mêmes règles (un job après l'autre, jamais pendant une autre tâche de sync) ; ses copies sont marquées **rejeu** dans Activité.
- **Changement de l'heure de départ** : il ne déclenche jamais de rejeu à lui seul. Si la série du jour a déjà tourné, son rejeu reste calé sur elle (même délai, mêmes runs examinés, rien si c'est déjà fait) ; si la nouvelle heure est encore à venir, la série repart aujourd'hui à cette heure ; si elle est déjà passée sans série ce jour-là, rien avant le lendemain.
- **Log de l'agent** (journal `homelab-agent` sur le PBS de secours) : `offsite: definition received: …` à chaque nouvelle définition (heure, délai de rejeu), `offsite: series of N sync job(s) started`, puis au délai `offsite: retry check of the series started <date heure>: X of N sync job(s) to run again` (même si X = 0) et, s'il y a lieu, `offsite: second pass of X sync job(s)`.
- L'agent parle à son PBS par `proxmox-backup-debug api` (API locale en root, dans le conteneur le cas échéant) : aucun jeton supplémentaire.
- **Pas de repli** sur la planification de PBS : agent arrêté ou trop ancien = plus de copie ; c'est signalé (alerte de l'hôte, ligne d'état dans Paramètres) et les sauvegardes passent « en retard ».

| Réglage (Paramètres › PBS de secours) | Défaut |
|---|---|
| connexion (hôte, adresse, empreinte, datastore cible, jetons) | voir Mise en place |
| heure de départ des copies quotidiennes | **04:00** (fuseau du hub) |

### Suivi en direct

Chaque copie est une tâche du PBS de secours ; le hub la suit et en fait un **job « Copie déportée »** (nommé d'après le datastore et le namespace, ex. `ds0 › Hosts`) sur l'**hôte du PBS de secours** :

- **lancée par l'agent** (« planifiée » dans Activité), avec le **journal de la tâche PBS en direct** : l'agent signale chaque copie qu'il lance, et le hub regarde aussi toutes les 30 secondes les tâches de sync en cours sur le PBS de secours ; il les suit de la même façon ; une copie qu'il n'a pas vue (hub arrêté) est enregistrée dans Activité au relevé suivant, avec son journal ;
- pendant la copie, le hub lit dans le journal la sauvegarde en cours de transfert : son nuage (pastille **détail**) pulse et la case du jour de sa frise clignote ; les autres sauvegardes du namespace indiquent « copie de son namespace en cours » ;
- à la fin, le résultat de **chaque sauvegarde** est tiré du journal : une ligne `sync group <type>/<id> failed - …` met cette sauvegarde en échec avec le message, les autres sont réussies ; une tâche en erreur sans sauvegarde nommée (namespace absent, connexion…) met tout le job en échec. Le job se ferme et le hub relit aussitôt le PBS de secours ;
- un redémarrage du hub reprend le suivi sur le même job.

### État d'une copie

Toutes les 15 minutes, et à la fin de chaque copie, le hub relève sur le PBS de secours l'état des sync jobs (dernier passage), les groupes copiés (dates des snapshots présents, dernier, taille, vérification) et l'occupation du datastore cible. L'état se compare au dernier snapshot **vérifié** du PBS principal (seuls ceux-là sont copiés).

| État | Signification |
|---|---|
| à jour | le dernier snapshot vérifié du PBS principal est sur le PBS de secours |
| en attente | un snapshot vérifié plus récent que la copie existe sur le PBS principal (ou rien n'est encore copié), depuis moins de 30 h |
| copie en cours | cette sauvegarde est en cours de transfert |
| en retard | ce snapshot vérifié (ou l'activation, si elle est plus récente) n'est toujours pas copié après **30 h** : une série quotidienne l'a manqué (agent arrêté, copie trop longue…) |
| en échec | le dernier passage a échoué pour cette sauvegarde, ou le PBS de secours a refusé son job |

« En échec » est une alerte, « en retard » un avertissement : ils s'ajoutent à ceux de la sauvegarde. Le détail d'une sauvegarde copiée donne aussi la prochaine série (« prochaine série dans 9 heures »), la copie en cours, ou l'agent hors ligne ou à mettre à jour.

## Monter une sauvegarde (lecture seule)

L'interface du PBS ne restaure une sauvegarde qu'en entier, ou fichier par fichier. Homelab Manager **monte un snapshot** en lecture seule dans un répertoire d'un hôte (`proxmox-backup-client mount`, FUSE), sans rien extraire : on parcourt, on copie ce qu'il faut, on démonte.

- Sauvegardes de répertoires (`host`) et de conteneurs (`ct`), archives `.pxar` ; pas de VM (PVE et PBS savent les restaurer à côté de l'origine), ni d'archive chiffrée.
- **Un seul montage à la fois** dans tout le hub. **Jamais de démontage automatique** : tant qu'une sauvegarde est montée, un bandeau orange reste sur le tableau de bord et la page Sauvegardes, et l'hôte (donc son site) est en avertissement dans le domaine **Montage PBS** ([Alertes et statuts](alertes.md)).
- Administrateurs seulement.

### Monter

Page Sauvegardes › icône de montage sur la ligne de la sauvegarde : une fenêtre en quatre étapes, pré-sélectionnée sur cette sauvegarde.

1. **Sauvegarde** : le PBS (principal ou de secours), puis la sauvegarde. Depuis le PBS de secours, seules celles qu'il a copiées (sync jobs `hlm-*`) sont proposées.
2. **Snapshot** : lus à l'instant sur le PBS choisi (celui de secours a ses propres snapshots et sa propre rétention).
3. **Archive** : une par répertoire sauvegardé, `root.pxar` pour un conteneur.
4. **Destination** : par défaut **l'hôte du PBS**. Les autres hôtes proposés ont un agent connecté qui sait monter (capacité « pbs_mount » : `proxmox-backup-client` installé **nativement** — l'image Docker du client ne peut pas monter pour l'hôte —, `/dev/fuse` et systemd) et qui **joint ce PBS** : son agent teste à l'instant le port et l'empreinte du certificat. Si l'hôte est configuré pour Tailscale et que l'adresse Tailscale du PBS est renseignée, elle est choisie automatiquement ; sinon l'adresse normale est utilisée. « Lien lent » signale une lecture entre sites, pas le seul fait de lire depuis le PBS de secours : restaurer sur le même site que ce PBS est indiqué comme direct.

La racine est configurable dans **Paramètres › Sauvegardes › Proxmox Backup Server** (par défaut `/srv/pbs-restore`). Le montage arrive dessous sous `<type>-<id>_<date>_<archive>` (par exemple `/srv/pbs-restore/ct-101_2026-10-19_02-30-00_root`), lisible par root seulement. Le chemin est rappelé dans le bandeau.

### Ce qui se passe

- Le client tourne **toujours sur l'hôte de destination**, dans une unité systemd transitoire `hlm-pbs-mount`, jamais dans le conteneur d'un PBS : pour le PBS de secours en conteneur, il passe par le port publié (pas de `/dev/fuse` ni de `SYS_ADMIN` dans le conteneur). Pour qu'il en soit la destination, l'hôte Docker du PBS doit avoir le client natif (installation par APT depuis sa fiche).
- **Jeton volatil** : au montage, l'agent du PBS crée `homelab-mount@pbs!m<horodatage>`, `DatastoreReader` sur le seul namespace de la sauvegarde. Son secret va à l'agent de la destination dans la requête seulement, puis dans un fichier d'environnement de systemd (root, `0600`) supprimé dès le démarrage de l'unité : jamais en base, dans les journaux, dans l'interface ni sur une ligne de commande.
- Le montage est enregistré **avant** la création du jeton : quoi qu'il arrive ensuite (échec, redémarrage du hub), le hub sait qu'un jeton peut exister et le révoque.

### Démonter

**Démonter** (bandeau) arrête l'unité, démonte, supprime le répertoire vide, puis l'agent du PBS **révoque le jeton** (et l'utilisateur `homelab-mount@pbs` quand il n'a plus de jeton). Ce qui ne peut pas se faire tout de suite (agent hors ligne) se fait à son retour ; le bandeau l'indique (« démontage en attente ») et l'avertissement reste jusque-là. Le jeton est révoqué même si l'hôte n'a pas encore pu démonter : le montage ne peut alors plus rien lire.

Un montage perdu (redémarrage de l'hôte, unité arrêtée à la main) est constaté au retour de l'agent ou au plus tard 5 minutes après : le jeton est révoqué, le montage oublié. Un hôte qui porte un montage ne peut pas être supprimé.

### Conteneurs non privilégiés : uid décalés

Une sauvegarde de CT non privilégié garde les propriétaires **vus depuis l'hôte Proxmox** : décalés de 100000 (`root` du conteneur = uid 100000, l'utilisateur 1000 = 101000). Copier vers le conteneur d'origine en conservant ces uid donnerait des fichiers inaccessibles : copier sans les propriétaires (`cp -r --no-preserve=ownership`, `rsync -rlt`), puis rétablir le propriétaire dans le conteneur ; ou copier depuis l'hôte Proxmox vers le rootfs du conteneur en gardant les uid décalés (`rsync -a`).

## Déconnecter un PBS ou un cluster

Homelab Manager revient à un état **sans** ce serveur : il retire ce qu'il y a créé (ses jetons, l'utilisateur d'un jeton quand il n'en porte plus d'autre, et sur le PBS de secours ses sync jobs `hlm-*` et la remote `hlm-main`) et ses propres données. Il ne supprime **jamais** un snapshot, un groupe, un namespace ou un datastore. Chaque action passe par une confirmation qui liste ce qui part.

Avant toute étape, le hub vérifie que chaque agent nécessaire est **en ligne et à jour** (capacités « pbs_token_delete », « pve_token_delete ») : sinon la déconnexion est refusée, rien n'est touché. Un jeton est révoqué par l'agent du serveur : ses droits, le jeton, puis l'utilisateur et ses droits s'il n'a plus de jeton (`homelab@pbs` porte à la fois `!monitor` et `!reader` sur le PBS principal).

| Action | Où | Ce qui part |
|---|---|---|
| **Déconnecter le PBS principal** (icône débrancher) | Paramètres › Sauvegardes, ligne du PBS | le PBS de secours d'abord (il tire du principal, ligne suivante) ; les agents des hôtes reçoivent une définition vide et arrêtent leurs sauvegardes ; les jetons des hôtes et `homelab@pbs!monitor` sont révoqués ; les réglages du PBS et les groupes relevés sont oubliés |
| **Déconnecter le PBS de secours** | ligne du PBS de secours | la série quotidienne de son agent, les sync jobs `hlm-*`, la remote `hlm-main`, les jetons `homelab@pbs!hub` (secours) et `homelab@pbs!reader` (principal), ses réglages ; les copies restent sur le PBS de secours, les choix de copie des sauvegardes sont gardés |
| **Retirer un cluster Proxmox VE** | ligne du cluster | son jeton (`homelab@pve!monitor`), révoqué par l'agent du nœud relié ; ses guests, leurs liens aux hôtes et le rattachement automatique de leurs sauvegardes (orphelines) |
| **Retirer le jeton d'un hôte** | API seulement (`DELETE /api/hosts/:id/pbs-credential`) | ce jeton, révoqué sur le PBS (plus seulement oublié par le hub) |

Sans PBS, la page Sauvegardes, la carte des hôtes, le tableau de bord et Home Assistant continuent d'afficher les **sauvegardes Home Assistant** (elles ne passent pas par le PBS) et les clusters Proxmox VE (guests, couverture par un job ; sans snapshots, ceux-ci étant lus sur le PBS).

### Reconnexion : ce qui a été mis de côté

La déconnexion du PBS principal met de côté, par hôte, ce qui avait été saisi à la main :

- les **jobs de sauvegarde** créés depuis la carte Sauvegardes (répertoires, bases) : une fois un PBS connecté, ils apparaissent sur la carte de l'hôte, en **ambre et en pointillés** (« à restaurer »), avec deux icônes : **Valider** recrée le job (même identifiant, son historique suit) et le jeton de l'hôte, **Annuler** l'oublie. Si le job n'est plus valable tel quel (datastore absent, groupe pris), Valider ouvre son formulaire pré-rempli ;
- les réglages du **plugin Nextcloud AIO** : le bouton Nextcloud passe en ambre ; sa fenêtre s'ouvre pré-remplie, recalée sur l'instance et les datastores du moment (utilisateur disparu retiré, datastore absent à choisir, chaque écart signalé) ; **Enregistrer** restaure, **Oublier cette configuration** l'abandonne. Les jobs générés par le plugin ne sont pas gardés : il les recrée.

Le jeton d'un hôte est recréé avec **le même identifiant** qu'avant : le propriétaire d'un groupe PBS étant l'identifiant du jeton qui l'a écrit, l'hôte retrouve ses anciens groupes. Un autre identifiant ne pourrait plus y écrire (« owner check failed »).

## Lien hôte ↔ guest Proxmox

L'agent remonte les adresses MAC de ses interfaces ; le hub cherche le guest qui porte l'une d'elles, sur tous les clusters. Une correspondance **unique** lie l'hôte à son CT ou sa VM (badge `CT 171 · pve1` sur la carte Sauvegardes) ; une MAC présente sur plusieurs guests, ou un hôte qui en désigne plusieurs, ne lie rien. Rien n'est écrit sur Proxmox.

Les groupes que les jobs de ce guest écrivent sur le PBS (`<datastore>/<namespace>/ct|vm/<vmid>`) sont alors rattachés à l'hôte, sans action ; un job qui n'a encore rien écrit apparaît « jamais sauvegardée ». Les jobs qui écrivent **ailleurs que sur le PBS suivi** (`local`, NFS, autre PBS) donnent aussi une sauvegarde par stockage, lue sur Proxmox et alertée de la même façon ; hors PBS, elle n'est ni copiée sur le PBS de secours ni montable. Si la VM ou le CT disparaît de l'inventaire, le lien est mis de côté (Rétablir / Oublier sur la fiche hôte). Tout est décrit dans [Proxmox VE](proxmox-ve.md). Un guest lié qu'aucun job actif ne couvre déclenche l'alerte « couvert par aucun job de sauvegarde Proxmox ». Les guests sans agent (**non gérés**, visibles dans Paramètres › Proxmox VE) ne sont pas suivis : leurs sauvegardes restent orphelines. Les VM **Home Assistant OS** ont un agent, sous forme d'application Home Assistant (voir [Installation](installation.md#home-assistant-os)) : leurs sauvegardes se rattachent comme les autres.

## Sauvegardes de répertoires

Définies dans Homelab Manager et exécutées par l'agent avec `proxmox-backup-client`. Le hub les définit, l'agent les exécute, le PBS les confirme.

Depuis la fiche hôte, carte **Sauvegardes** › **+ Sauvegarde** (administrateurs) : la fenêtre « Sauvegardes lancées par l'agent » liste ses jobs (répertoires et [bases de données](#sauvegardes-de-bases-de-données)) avec, pour chacun, lancer, modifier et supprimer, et **Ajouter** pour un nouveau job ; elle montre aussi l'état du client PBS et le jeton. Un job existant se modifie aussi directement par le crayon de sa ligne (fiche hôte ou page Sauvegardes) :

1. **Client PBS.** L'icône de l'en-tête de la carte indique son état : paquet vert = client installé (APT), conteneur bleu = image Docker présente, paquet barré = absent. Sans client, la fenêtre propose les installations possibles sur cet hôte :
   - **Installer via APT** : dépôt `pbs-client` de Proxmox et paquet `proxmox-backup-client` (Debian bookworm / trixie, **amd64** uniquement) ;
   - **Installer via Docker** : téléchargement de l'image du client, publiée pour **amd64** uniquement (repo [pbs-client](https://github.com/Mamath2000/pbs-client)).

   L'installation est une tâche de l'agent (visible dans Activité). Un hôte en mode Docker peut passer au client APT, qui est alors préféré. Ailleurs (arm64, autre distribution), installer le client à la main : l'agent le détecte.
2. **Accès PBS** : le jeton propre à l'hôte, créé par l'agent du PBS (**Créer le jeton** ; le PBS doit être relié à son agent). Il a `DatastoreBackup` sur le namespace `Hosts` de chaque datastore : il ne voit et ne modifie que les sauvegardes dont il est propriétaire, et ne peut pas écrire dans les namespaces de Proxmox VE.
3. **Ajouter** (bloqué tant qu'il n'y a ni client ni jeton) : type (**Répertoires**, **Base PostgreSQL**, **Base MongoDB** ; fixé à la création), nom, répertoires (une archive `.pxar` par répertoire, chemins absolus), exclusions, datastore, identifiant sur le PBS (groupe `host/<identifiant>`, fixé à la création), planification. Le namespace (`Hosts`) et le fuseau (celui du hub, variable `TZ`, fixé à la création du job) sont affichés sans être modifiables.

**Estimer la taille** (sous les exclusions, agent ≥ 0.3) : l'agent parcourt les répertoires du formulaire avec les exclusions saisies, **sans rien envoyer**, et affiche par répertoire la taille et le nombre de fichiers retenus, ce que les exclusions retirent et les 8 plus gros éléments exclus. Pour un job existant, la taille de son dernier snapshot sur le PBS est affichée à côté. Le résultat devient « à relancer » dès que les répertoires ou les exclusions changent ; l'estimation n'est jamais lancée automatiquement (elle lit l'arborescence de l'hôte, 3 minutes et 5 millions d'entrées au plus : au-delà, le chiffre est un minimum).
- `proxmox-backup-client` ne sait pas le faire (`--dry-run` ne parcourt rien) : l'agent applique **les règles du client, portées de son code** (crate `pathpatterns` et `pxar/create.rs`) — chemin testé relatif à la racine de l'archive ; motif sans `/` en tête valable à toute profondeur, avec `/` depuis la racine ; `*` et `?` ne traversent pas `/`, `**` si ; `/` final = répertoires seulement ; `!` ré-inclut ; le dernier motif qui correspond l'emporte ; un répertoire exclu n'est pas parcouru ; les fichiers `.pxarexclude` des répertoires sont pris en compte ; les autres systèmes de fichiers ne sont pas parcourus.
- Conformité vérifiée par les tests de l'agent : les assertions de `pathpatterns`, et des listes de référence produites par le vrai `pxar` sur une arborescence de test (`agent/testdata/estimate`, régénérées par `agent/testdata/estimate/regen.sh [hôte]` quand le client change de version).
- C'est la taille **brute** des fichiers (liens durs comptés une fois) : le PBS stocke moins (déduplication, compression), et la taille d'un snapshot affichée par le PBS inclut les métadonnées de l'archive.

**Rétention** : elle n'est pas choisie par job. C'est l'élagage du PBS qui s'applique (job d'élagage du namespace `Hosts` du datastore, ou options du datastore) ; le formulaire l'affiche sous le datastore (« Rétention (élagage du PBS, tous les jours à 21:00) : 10 quotidiennes · 3 mensuelles · 2 annuelles »), et avertit quand rien n'élague ce namespace. Choisir sa rétention revient à choisir son datastore ; elle se modifie dans le PBS (Datastore › Élagage et GC).

Planification : syntaxe des calendriers Proxmox — `03:00`, `sun 01:00`, `mon..fri 22:30`, `*/5` (toutes les 5 minutes), `daily`, `weekly`, `monthly`. Les dates et les secondes ne sont pas acceptées.

**Poste nomade : sauvegarde à la connexion.** Le champ **Déclenchement** du job propose, à la place de l'heure fixe, **À la connexion de l'agent** avec un délai **X jours** (1 à 365). À chaque connexion de l'agent au hub, le job se lance si la dernière sauvegarde **réussie** date de plus de X jours (jamais sauvegardé : au premier passage). Un échec est retenté à la connexion suivante, pas en boucle pendant la même ; une sauvegarde manuelle réussie remet le compteur à zéro. Le PBS doit être joignable au moment de la connexion (VPN, Tailscale). Nécessite un agent à jour (sinon le job reste « non appliqué »).

**Rejeu après échec.** Une sauvegarde planifiée dont l'exécution n'a pas réussi est **rejouée une fois** par l'agent, **4 h** après son heure prévue (réglage **Rejeu après échec (h)** en pied de la fenêtre Proxmox Backup Server, 0 = désactivé, valable pour les hôtes et pour la copie vers le PBS de secours). Le second passage saute si la sauvegarde a réussi ; il n'a lieu que si aucune autre échéance du job n'est intervenue entre-temps, et un échec du rejeu n'en déclenche pas un autre : au plus **un rejeu par job et par jour**, donc une panne générale coûte au pire le double de charge. Le job rejoué apparaît dans Activité avec le badge **rejeu** (déclencheur `retry`). Ne concerne pas les jobs « à la connexion » (déjà retentés à la connexion suivante). Nécessite un agent à jour (capacité `backup_retry`, sinon pas de rejeu pour cet hôte).

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

Sauvegarde complète d'une instance **Nextcloud All-in-One** : base, configuration et données de chaque utilisateur, chacune dans le datastore choisi. Le plugin est propre à ce type d'installation : il n'apparaît que si le hub a `FEATURE_BACKUP_NEXTCLOUD_AIO=true` (voir [Configuration](configuration.md)) **et** que l'agent de l'hôte (0.4 ou plus récent) trouve l'instance. Bouton **Nextcloud** de la carte Sauvegardes de l'hôte.

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
- Sans `FEATURE_BACKUP_NEXTCLOUD_AIO`, les jobs déjà générés continuent de tourner ; seule la fenêtre du plugin disparaît.

## Sauvegardes Home Assistant

L'agent des hôtes Home Assistant OS (application `homelab_agent`, voir [Installation](installation.md#home-assistant-os)) lit toutes les 15 minutes (ou sur demande : **Relever**, ou **Actualiser** sur la fiche de l'hôte), **en lecture seule**, les sauvegardes de Home Assistant Core par son API WebSocket (`backup/agents/info`, `backup/info`, `backup/config/info`, `get_config` pour le fuseau). L'application déclare `homeassistant_api` : seule l'API de Core voit les destinations apportées par des intégrations (SFTP, Google Drive, partage réseau…) ; Supervisor ne voit que le stockage local. Le mot de passe des sauvegardes n'est ni gardé ni envoyé.

- **Une ligne par destination** (`haos/<hôte>/<destination>`, store « Home Assistant ») : stockage local et chaque emplacement d'intégration qui est une destination des sauvegardes automatiques ou porte des sauvegardes. Un emplacement inutilisé (Home Assistant Cloud non configuré…) est ignoré.
- **Planification** : celle des sauvegardes automatiques de HA (récurrence, jours, heure, fuseau de HA) ; le retard se calcule comme pour une planification Proxmox.
- **Échec** : la destination figure dans les échecs de la dernière sauvegarde automatique, ou la sauvegarde automatique entière a échoué ; l'erreur de la destination est affichée sur la ligne.
- **Désactivée** : la destination ne reçoit pas les sauvegardes automatiques (sauf seuil manuel).
- Une destination illisible garde son historique ; une destination retirée dans Home Assistant disparaît du hub.

La capacité `ha_backups` n'apparaît sur l'hôte qu'après une première lecture réussie ; sinon le journal de l'application en donne la raison et l'agent réessaie au cycle suivant.

## Sauvegardes externes : rattachement manuel

Pour les sauvegardes faites ailleurs (script ou cron maison, outil tiers…) :
- **Fiche hôte**, carte **Sauvegardes** › **Rattacher** : la fenêtre liste les sauvegardes externes de l'hôte et celles du PBS rattachées à aucun hôte ; cocher celles qui lui appartiennent (administrateurs).
- **Détacher** : l'icône de la ligne. **Page Sauvegardes**, colonne **Hôte** : déplacer ou détacher.
- **Orphelines** (page Sauvegardes) : les sauvegardes du PBS rattachées à aucun hôte ; une orpheline disparue du PBS peut y être oubliée.

Les sauvegardes image PVE et répertoires ne se rattachent ni ne se détachent à la main.

## Retard

| Source du seuil | Règle |
|---|---|
| **manuel** | valeur choisie dans la colonne Seuil (26 h, 2 jours, 8 jours, 32 jours) |
| **planification** | image PVE, répertoires et Home Assistant : en retard si aucun snapshot depuis la dernière heure prévue, 2 h de marge comprises ; seuil affiché = une période + 2 h. Job « à la connexion » : seuil = X jours + 1 jour |
| **appris** | 1,5 × l'intervalle médian entre les derniers snapshots (au moins 4), 2 h de marge minimum |
| **rétention** | même calcul avec la période la plus fine gardée par l'élagage du PBS (`keep-daily` → quotidienne…) |
| **aucun** | aucune des sources précédentes (sauvegarde externe récente, moins de 4 snapshots, namespace sans élagage) : pas de seuil, **jamais en retard** ni d'alerte |

Une planification que le hub ne sait pas lire (`yearly`, dates) retombe sur le rythme appris ; sans rythme, pas d'alerte de retard.

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

- **Page Sauvegardes** : compteurs, espace des datastores et, avec un PBS de secours, celui de son datastore cible ; une ligne par sauvegarde suivie : nom (celui du job pour une sauvegarde de répertoires) et sa pastille **détail**, **type**, hôte, 30 derniers jours, dernière, taille, vérification, état, seuil et, avec un PBS de secours, **copie déportée** (état et âge de la dernière copie, « non copiée », « — non copiable »). Filtres : en retard / échec, **type**, hôte, recherche.
- **Volume transféré** : colonne **Transféré (30 j)** sur chaque ligne (petites barres par jour) et, au-dessus de la liste, un panneau avec le volume par jour (barres) et le temps de sauvegarde cumulé par jour (courbe, axe de droite), bascule **30 j / 60 j**. Détail [ci-dessous](#volume-transféré-et-durée).
- **Fiche hôte**, carte **Sauvegardes** : icône du client PBS, guest Proxmox lié, alerte « non couvert », chaque sauvegarde sur une ligne de titre (nom, état, type, pastille **détail**, actions) et une ligne de détail (datastore, dernière, taille, vérification) à côté de sa frise ; boutons **+ Sauvegarde**, **Rattacher**, et sur chaque ligne d'un job de l'agent le crayon (modifier) et **Lancer**.
- **Pastille « détail »**, sur toutes les sauvegardes : un clic ouvre le détail de la sauvegarde (type, datastore, dernière, planification ou rythme, délai avant alerte et sa source, bases d'un job de bases) et de sa **copie déportée** (état, dernier snapshot copié et sa vérification sur le PBS de secours, prochaine série ou copie en cours, erreurs, place sur le PBS de secours, boutons **Copier maintenant** et **Retirer de la copie** ; pour une sauvegarde non copiée, la vérification « copiable » et **Activer la copie**). Le nuage de la pastille donne l'état de la copie quand il y en a une : bleu à jour, gris en attente, orange en retard, rouge en échec, pulsant en cours de transfert.
- **Frise à deux voies** (avec un PBS de secours) : sous les 30 jours de la sauvegarde, une voie fine pour les copies — bleu = un snapshot de ce jour est sur le PBS de secours et vérifié (bleu pâle : non vérifié, rouge : vérification en échec), contour orange = copie manquante, rouge = manquante et dernière copie en échec, pointillés = copie non activée ; rien pour une sauvegarde non copiable. Une copie est attendue pour un snapshot antérieur au début de la dernière copie et pas plus ancien que la plus ancienne copie (le PBS de secours élague de son côté).
- **Fenêtre d'une sauvegarde** de l'agent (format 16:9, onglets à gauche) : **Contenu**, **Destination**, **Planning** et, avec un PBS de secours, **Copie déportée** (activation, rappel de l'heure des copies et du job de son namespace, état, place), enregistrée avec la sauvegarde ; un récapitulatif reste en pied de fenêtre.
- **Snapshots** : l'icône en forme de couches, sur chaque ligne (page Sauvegardes, à côté du nom ; fiche hôte, à droite), ouvre la liste des snapshots de la sauvegarde, du plus récent au plus ancien. Elle affiche d'abord les 4 derniers, puis **Voir tout** déplie l'historique gardé par le hub (30 au plus ; la fenêtre indique quand le PBS en a davantage). Colonnes :
  - date d'exécution (relative au survol) ;
  - taille ;
  - vérification : vérifiée / en échec / non vérifiée ;
  - note : commentaire du snapshot, nom du guest pour un vzdump.

  C'est l'historique vu au dernier relevé, sans lecture du PBS en direct.
- **Liste des hôtes** : badge « sauvegarde en retard / en échec / désactivée ». **Tableau de bord** : moitié basse du carré de chaque hôte, chiffres clés et liste « Sauvegardes à surveiller ».

### Volume transféré et durée

Le hub lit les tâches de sauvegarde du PBS (liste et journal de chaque tâche) et en retient, par tâche, la somme des **« Upload size »** et la durée (début → fin). C'est le volume réellement envoyé après déduplication (nouveaux chunks), **pas** la taille du disque sauvegardé. Valable pour tous les types (image PVE, répertoires, bases, externes).

- Stockage : collection `backupStats`, une ligne par tâche, conservée 400 jours ; lecture par `GET /api/backups/stats?days=30|60`.
- Relevé : au premier passage, reprise de l'historique jusqu'à 400 jours, par lots de 300 tâches par relevé (les plus récentes d'abord) ; ensuite incrémental, toutes les 15 min.
- Une tâche en échec compte dans la durée avec un volume de 0 (barre rouge).
- Droit requis : `Audit` sur `/system/tasks` pour le jeton de supervision (voir [portée de chaque jeton](#portée-de-chaque-jeton)) et agent du PBS à jour. Sans ce droit, le panneau affiche « Statistiques indisponibles » avec la raison.

## Home Assistant

- Par hôte ayant des sauvegardes, un sous-appareil **Sauvegardes** : date de la dernière sauvegarde (détail des groupes en attributs), nombre en retard, alertes.
- Alertes : en retard / jamais sauvegardée, dernière exécution en échec, job désactivé, pas encore appliquée par l'agent, vérification en échec, disparue du PBS, copie déportée en retard / en échec, guest non couvert. Elles remontent à l'hôte puis à Homelab Manager. Pas d'alerte pour les orphelines, ni de retard pour un hôte itinérant absent.
- Statut : les sauvegardes forment le domaine **Sauvegardes** et la copie déportée le domaine **Copie externe** (ligne propre dans la frise de la fiche dès qu'une copie est activée, avertissement tant qu'aucune copie n'existe encore) : voir [Alertes et statuts](alertes.md).
- Sur Homelab Manager : **Sauvegardes en retard** et l'occupation de chaque datastore.

## Profils

Tous les profils voient les sauvegardes et le détail de leur copie. Les opérateurs peuvent relever, **lancer** une sauvegarde de répertoires et **copier maintenant** une sauvegarde copiée. Seuls les administrateurs règlent les connexions (PBS, PBS de secours, clusters), les jetons, les jobs, l'installation du client, le rattachement, le seuil propre à une sauvegarde et sa copie déportée, et **montent / démontent** une sauvegarde.
