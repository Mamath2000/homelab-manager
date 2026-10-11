---
title: Sauvegardes
description: Suivi des sauvegardes Proxmox Backup Server par son API, rattachées aux hôtes, avec alertes de retard dans l'interface et Home Assistant
sidebar_position: 3.7
---

# Sauvegardes

Homelab Manager suit les sauvegardes d'un **Proxmox Backup Server** (PBS) en lisant son API avec un jeton en lecture seule. Il n'installe rien sur les hôtes et ne modifie pas les scripts de sauvegarde (`proxmox-backup-client` lancé par cron) : le PBS sert de référence.

Les sauvegardes [ElkarBackup](https://github.com/Mamath2000/homelab-manager/issues/9), ainsi que le lancement et la configuration des sauvegardes depuis l'interface ([suite](https://github.com/Mamath2000/homelab-manager/issues/10)), viendront plus tard.

## Mise en place

### 1. Un jeton en lecture seule sur le PBS

```bash
# un utilisateur dédié (ou un utilisateur existant)
proxmox-backup-manager user create homelab@pbs
# son jeton : noter le secret affiché, il n'est montré qu'une fois
proxmox-backup-manager user generate-token homelab@pbs monitor
# lecture seule sur tous les datastores
proxmox-backup-manager acl update /datastore DatastoreAudit --auth-id 'homelab@pbs!monitor'
```

Ou dans l'interface du PBS : **Configuration › Contrôle d'accès** (onglet Jetons API, puis Permissions : rôle `DatastoreAudit` sur `/datastore` pour le jeton).

### 2. Paramètres › Sauvegardes

| Champ | Exemple |
|---|---|
| Adresse du PBS | `https://192.168.100.20:8007` |
| Empreinte du certificat | **Récupérer** lit celle que présente le PBS ; à comparer avec **Tableau de bord › Afficher l'empreinte** dans le PBS |
| Identifiant du jeton | `homelab@pbs!monitor` |
| Secret du jeton | jamais renvoyé par le hub après l'enregistrement |
| Seuil de retard par défaut | `26` heures, quand ni l'historique ni la rétention ne donnent de rythme |

**Tester la connexion** liste les datastores visibles. Une fois enregistré, le hub relève le PBS toutes les 15 minutes ; **Relever** sur la page Sauvegardes le fait tout de suite.

:::info Certificat épinglé
Le certificat du PBS est auto-signé : le hub n'accepte que celui dont l'empreinte est enregistrée, quel que soit son émetteur, et vérifie l'empreinte avant d'envoyer le jeton. Après un renouvellement du certificat du PBS, récupérer à nouveau l'empreinte. Sans empreinte, le certificat doit être valide pour les autorités du système (certificat ACME, par exemple).
:::

## Rattacher les sauvegardes aux hôtes

**Seules les sauvegardes rattachées à un hôte sont suivies** (état, retard, alertes). Le rattachement est toujours manuel, car le PBS contient aussi des sauvegardes qui ne relèvent pas d'un hôte géré ici, par exemple celles des VM et CT planifiées par Proxmox VE (elles seront traitées plus tard).

- **Depuis la fiche hôte**, carte **Sauvegardes** › **Rattacher** : une fenêtre liste les sauvegardes de l'hôte et celles du PBS qui ne sont rattachées à aucun hôte. On coche celles qui lui appartiennent, puis Enregistrer (administrateurs).
- **Détacher** : l'icône de chaque ligne de la carte. La sauvegarde redevient orpheline et n'est plus suivie.
- **Depuis la page Sauvegardes**, la colonne **Hôte** permet de déplacer une sauvegarde vers un autre hôte ou de la détacher.
- Le bouton **Orphelines** de la page Sauvegardes liste les sauvegardes du PBS rattachées à aucun hôte (datastore, namespace, nom, dernière, nombre de snapshots). Une orpheline disparue du PBS peut y être oubliée.

## Retard : rythme appris

Une sauvegarde est **en retard** quand son dernier snapshot est plus ancien que son seuil. Le seuil est calculé ainsi, dans cet ordre :

| Source | Seuil |
|---|---|
| **manuel** | valeur choisie dans la colonne Seuil (26 h, 2 jours, 8 jours, 32 jours) |
| **appris** | 1,5 × l'intervalle médian entre ses derniers snapshots (au moins 4), avec 2 h de marge minimum : 36 h pour une sauvegarde quotidienne, 10,5 jours pour une hebdomadaire, 3 h pour une horaire |
| **rétention** | même calcul, avec la période la plus fine gardée par l'élagage du PBS (`keep-daily` → quotidienne, `keep-weekly` → hebdomadaire…), job d'élagage du namespace ou options du datastore |
| **défaut** | le seuil de **Paramètres › Sauvegardes** (26 h) |

Le PBS ne connaît pas la planification des sauvegardes faites par `proxmox-backup-client` (elles sont lancées par cron sur les hôtes) : le rythme est donc déduit de l'historique des snapshots.

## Page Sauvegardes

Une ligne par sauvegarde suivie :
- hôte ;
- les **30 derniers jours** (une case par jour, verte s'il y a eu un snapshot, rouge s'il manque pour une sauvegarde au moins quotidienne) ;
- dernière sauvegarde, taille, vérification ;
- état ;
- seuil et sa source.

| État | Signification |
|---|---|
| à jour | dernier snapshot plus récent que le seuil |
| en retard | dernier snapshot plus ancien que le seuil |
| vérification en échec | la dernière vérification (verify job du PBS) a échoué |
| disparue du PBS | le groupe n'existe plus sur le PBS (supprimé, élagué) |

En haut : les compteurs et l'espace utilisé de chaque datastore.

## Ailleurs dans l'interface

- **Fiche hôte** : carte **Sauvegardes**, à côté des paquets (sur un écran large) : chaque sauvegarde rattachée, son état, son rythme, son seuil et ses 30 derniers jours.
- **Liste des hôtes** : badge « sauvegarde en retard » ou « en échec ».
- **Tableau de bord** : section Sauvegardes, avec celles à surveiller.

## Home Assistant

- Par hôte ayant des sauvegardes, un sous-appareil **Sauvegardes** : date de la dernière sauvegarde (avec le détail des groupes en attributs), nombre en retard, alertes.
- Les alertes (en retard, vérification en échec, disparue du PBS) remontent à l'hôte puis à Homelab Manager. Les sauvegardes orphelines n'ont pas d'alerte.
- Sur Homelab Manager : **Sauvegardes en retard** et l'occupation de chaque datastore (`Datastore ds3`, en %).
- Un hôte itinérant absent n'a pas d'alerte de retard : il ne peut pas sauvegarder tant qu'il n'est pas là.

## Rôles

Tous les rôles voient les sauvegardes. Les opérateurs peuvent relever le PBS. Seuls les administrateurs règlent la connexion, le rattachement et les seuils.
