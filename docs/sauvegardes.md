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
| En retard après | `26` heures (sauvegardes quotidiennes) |

**Tester la connexion** liste les datastores visibles. Une fois enregistré, le hub relève le PBS toutes les 15 minutes ; **Relever** sur la page Sauvegardes le fait tout de suite.

:::info Certificat épinglé
Le certificat du PBS est auto-signé : le hub n'accepte que celui dont l'empreinte est enregistrée, quel que soit son émetteur, et vérifie l'empreinte avant d'envoyer le jeton. Après un renouvellement du certificat du PBS, récupérer à nouveau l'empreinte. Sans empreinte, le certificat doit être valide pour les autorités du système (certificat ACME, par exemple).
:::

## Page Sauvegardes

Une ligne par **groupe** du PBS (datastore, namespace, type, identifiant) :
- dernière sauvegarde, taille du dernier snapshot, nombre de snapshots ;
- vérification du dernier snapshot ;
- état :

| État | Signification |
|---|---|
| à jour | dernier snapshot plus récent que le seuil |
| en retard | dernier snapshot plus ancien que le seuil |
| vérification en échec | la dernière vérification (verify job du PBS) a échoué |
| disparue du PBS | le groupe n'existe plus (supprimé, élagué) ; sans alerte, on peut l'oublier |
| ignorée | décochée dans « Suivi » : ni état ni alerte (ancienne machine…) |

En haut : les compteurs et l'espace utilisé de chaque datastore.

### Rattachement aux hôtes

Automatique quand l'identifiant de la sauvegarde est le **nom** ou le **hostname** d'un hôte, éventuellement suivi de `_…` ou `-…` (casse ignorée) :

| Sauvegarde | Hôte |
|---|---|
| `host/pve-docker01` | l'hôte dont le hostname est `pve-docker01` |
| `host/pgsql_nextcloud` (module PostgreSQL) | l'hôte `pgsql` |
| `ct/105`, notes `pihole` | l'hôte `pihole` (VM et CT : par leurs notes) |
| `host/nextcloud` | sans hôte, à rattacher à la main si besoin |

Les administrateurs peuvent choisir l'hôte dans la colonne **Hôte** (choix gardé aux relevés suivants), ou revenir au rattachement automatique.

### Seuil

Le seuil par défaut vient des paramètres (26 h). Chaque sauvegarde peut avoir le sien : quotidienne, 2 jours, hebdomadaire, mensuelle.

## Ailleurs dans l'interface

- **Fiche hôte** : ligne **Sauvegarde** dans le panneau Système (dernière sauvegarde, en retard ou en échec), lien vers ses sauvegardes.
- **Liste des hôtes** : badge « sauvegarde en retard » ou « en échec ».
- **Tableau de bord** : section Sauvegardes, avec celles à surveiller.

## Home Assistant

- Par hôte ayant des sauvegardes, un sous-appareil **Sauvegardes** : date de la dernière sauvegarde (avec le détail des groupes en attributs), nombre en retard, alertes.
- Les alertes remontent à l'hôte puis à Homelab Manager ; celles des sauvegardes sans hôte vont directement à Homelab Manager.
- Sur Homelab Manager : **Sauvegardes en retard** et l'occupation de chaque datastore (`Datastore ds3`, en %).
- Un hôte itinérant absent n'a pas d'alerte de retard : il ne peut pas sauvegarder tant qu'il n'est pas là.

## Rôles

Tous les rôles voient les sauvegardes. Les opérateurs peuvent relever le PBS. Seuls les administrateurs règlent la connexion, le rattachement, les seuils et le suivi.
