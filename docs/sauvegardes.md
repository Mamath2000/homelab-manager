---
title: Sauvegardes
description: Suivi des sauvegardes d'un Proxmox Backup Server, des jobs vzdump de Proxmox VE rattachés aux CT et VM, et sauvegardes de répertoires lancées par les agents, avec alertes dans l'interface et Home Assistant
sidebar_position: 3.7
---

# Sauvegardes

Homelab Manager suit les sauvegardes d'un **Proxmox Backup Server** (PBS) et les rattache aux hôtes. Il en connaît trois sortes, affichées dans la colonne **Type** :

| Type | Origine | Rattachement à l'hôte | Retard jugé sur |
|---|---|---|---|
| **image PVE** | job de sauvegarde (vzdump) d'un cluster Proxmox VE : image complète du CT ou de la VM | automatique : l'hôte est le guest qui porte une de ses adresses MAC | la planification du job |
| **répertoires** | sauvegarde définie dans Homelab Manager et lancée par l'agent de l'hôte | automatique : le hub a créé le job, il connaît son groupe | la planification du job |
| **externe** | faite hors Homelab Manager (`backup_pbs_scripts` par cron, ElkarBackup…) | à la main, depuis la fiche hôte | le rythme appris de ses snapshots |

Le PBS reste la référence : un snapshot n'est « fait » que lorsqu'il est sur le PBS.

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

Le fuseau proposé pour les sauvegardes de répertoires est celui du hub : variable `TZ` du compose (défaut `Europe/Paris`).

**Tester la connexion** liste les datastores visibles (avertissement si aucun : revoir les droits). Le hub relève le PBS toutes les 15 minutes, et aussitôt après une sauvegarde de répertoires réussie ; **Relever** sur la page Sauvegardes le fait tout de suite.

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

Les groupes que les jobs de ce guest écrivent sur le PBS (`<datastore>/<namespace>/ct|vm/<vmid>`) sont alors rattachés à l'hôte, sans action ; un job qui n'a encore rien écrit apparaît « jamais sauvegardée ». Un guest lié qu'aucun job actif ne couvre déclenche l'alerte « couvert par aucun job de sauvegarde Proxmox ». Les guests sans agent ne sont pas suivis : leurs sauvegardes restent orphelines.

## Sauvegardes de répertoires

Définies dans Homelab Manager et exécutées par l'agent avec `proxmox-backup-client`. Le hub les définit, l'agent les exécute, le PBS les confirme.

Depuis la fiche hôte, carte **Sauvegardes** › **Répertoires** :

1. **Client PBS.** L'icône de l'en-tête de la carte indique son état : paquet vert = client installé (APT), conteneur bleu = image Docker présente, paquet barré = absent. Sans client, la fenêtre propose les installations possibles sur cet hôte :
   - **Installer via APT** : dépôt `pbs-client` de Proxmox et paquet `proxmox-backup-client` (Debian bookworm / trixie, **amd64** uniquement) ;
   - **Installer via Docker** : téléchargement de l'image du client, publiée pour **amd64** uniquement (repo [pbs-client](https://github.com/Mamath2000/pbs-client)).

   L'installation est une tâche de l'agent (visible dans Activité). Un hôte en mode Docker peut passer au client APT, qui est alors préféré. Ailleurs (arm64, autre distribution), installer le client à la main : l'agent le détecte.
2. **Accès PBS** : le jeton propre à l'hôte, créé par la commande à usage unique. Il a `DatastoreBackup` sur le namespace `Hosts` de chaque datastore : il ne voit et ne modifie que les sauvegardes dont il est propriétaire, et ne peut pas écrire dans les namespaces de Proxmox VE.
3. **Ajouter** (bloqué tant qu'il n'y a ni client ni jeton) : nom, répertoires (une archive `.pxar` par répertoire, chemins absolus), exclusions, datastore, identifiant sur le PBS (groupe `host/<identifiant>`, fixé à la création), planification, fuseau (par défaut celui du hub, variable `TZ`). Le namespace est toujours `Hosts`.

Planification : syntaxe des calendriers Proxmox — `03:00`, `sun 01:00`, `mon..fri 22:30`, `*/5` (toutes les 5 minutes), `daily`, `weekly`, `monthly`. Les dates et les secondes ne sont pas acceptées.

Fonctionnement :
- le hub envoie à l'agent toute la définition de l'hôte (jobs, jeton, empreinte, image) à chaque modification et à chaque connexion ; l'agent la garde sur disque (fichier lisible par root seulement ; sur Unraid, sur la clé USB) ;
- **l'agent planifie lui-même** : les sauvegardes continuent si le hub est arrêté ; une heure manquée pendant que l'agent était arrêté est **rattrapée** à son redémarrage ; un job ne rattrape jamais une heure antérieure à sa création ;
- le secret passe par l'environnement du client, jamais par sa ligne de commande ; en conteneur, les répertoires sont montés en lecture seule au même chemin ;
- chaque résultat est gardé par l'agent jusqu'à ce que le hub l'ait reçu : il apparaît dans **Activité** (« Sauvegarde · home », planifiée ou manuelle) avec le journal, et une erreur montre la ligne `Error:` du client (par ex. droits manquants sur un datastore) ;
- **Lancer** (sur la ligne de la sauvegarde, carte Sauvegardes) l'exécute tout de suite ; une sauvegarde peut durer : elle ne bloque pas les autres tâches de l'hôte.

Supprimer un job laisse ses snapshots sur le PBS (le groupe devient orphelin).

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
| **planification** | image PVE et répertoires : en retard si aucun snapshot depuis la dernière heure prévue, 2 h de marge comprises ; seuil affiché = une période + 2 h |
| **appris** | 1,5 × l'intervalle médian entre les derniers snapshots (au moins 4), 2 h de marge minimum |
| **rétention** | même calcul avec la période la plus fine gardée par l'élagage du PBS (`keep-daily` → quotidienne…) |
| **aucun** | aucune des sources précédentes (sauvegarde externe récente, moins de 4 snapshots, namespace sans élagage) : pas de seuil, **jamais en retard** ni d'alerte |

Une planification que le hub ne sait pas lire retombe sur le rythme appris.

| État | Signification |
|---|---|
| à jour | snapshot présent pour la dernière échéance |
| en retard | pas de snapshot depuis l'échéance (ou « jamais sauvegardée ») |
| dernière exécution en échec | la dernière tâche vzdump du guest, ou la dernière exécution de l'agent, a échoué après le dernier snapshot |
| job désactivé | tous les jobs qui écrivent cette sauvegarde sont désactivés |
| pas encore appliquée par l'agent | l'agent n'a pas encore reçu la définition actuelle (hors ligne, client absent…) |
| vérification en échec | la dernière vérification (verify job du PBS) a échoué |
| disparue du PBS | le groupe n'existe plus sur le PBS |

## Interface

- **Page Sauvegardes** : compteurs et espace des datastores ; une ligne par sauvegarde suivie : nom (celui du job pour une sauvegarde de répertoires), **type**, hôte, 30 derniers jours, dernière, taille, vérification, état, seuil. Filtres : en retard / échec, **type**, hôte, recherche.
- **Fiche hôte**, carte **Sauvegardes** : icône du client PBS, guest Proxmox lié, alerte « non couvert », chaque sauvegarde avec son type, son état, sa planification ou son rythme et sa frise des 30 derniers jours ; boutons **Répertoires**, **Rattacher**, **Lancer**.
- **Liste des hôtes** : badge « sauvegarde en retard / en échec / désactivée ». **Tableau de bord** : section Sauvegardes.

## Home Assistant

- Par hôte ayant des sauvegardes, un sous-appareil **Sauvegardes** : date de la dernière sauvegarde (détail des groupes en attributs), nombre en retard, alertes.
- Alertes : en retard / jamais sauvegardée, dernière exécution en échec, job désactivé, pas encore appliquée par l'agent, vérification en échec, disparue du PBS, guest non couvert. Elles remontent à l'hôte puis à Homelab Manager. Pas d'alerte pour les orphelines, ni de retard pour un hôte itinérant absent.
- Sur Homelab Manager : **Sauvegardes en retard** et l'occupation de chaque datastore.

## Rôles

Tous les rôles voient les sauvegardes. Les opérateurs peuvent relever et **lancer** une sauvegarde de répertoires. Seuls les administrateurs règlent les connexions (PBS, clusters), les jetons, les jobs, l'installation du client, le rattachement et le seuil propre à une sauvegarde.
