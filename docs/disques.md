---
title: Disques
description: Page Disques transverse à tous les hôtes, avec les disques physiques, volumes, RAID mdadm et Unraid, Ceph, stockages Proxmox VE et disques des VM et CT. Elle propose une matrice site × nature, un tableau triable, une vue hiérarchique et l'endpoint /api/disks
sidebar_position: 3.62
---

# Disques

La page **Disques** rassemble sur un seul écran tout ce qui stocke des données dans le homelab : espace libre, santé, SMART et RAID. Elle ne collecte rien de plus que la [santé](sante.md). Elle reprend ses mesures, ses seuils et ses alertes, et les croise avec l'inventaire des [clusters Proxmox VE](proxmox-ve.md).

## Ce qui est listé

| Nature | Source | Exemple |
|---|---|---|
| **Volume** | volumes de la santé d'un hôte | `/`, `/mnt/datastore` |
| **Disque** | disques SMART suivis, membres d'un RAID, disques d'un OSD Ceph | Samsung PM983 1.92TB |
| **RAID** | arrays mdadm, array Unraid | `/dev/md0`, Array Unraid |
| **Ceph** | cluster Ceph (un par `fsid`), pools RBD déclarés comme stockages Proxmox VE | Ceph maison, `ceph-vm` |
| **Stockage PVE** | stockages actifs d'un cluster Proxmox VE (un stockage partagé n'apparaît qu'une fois) | `local-lvm` |
| **Disque VM / CT** | disques déclarés dans la configuration des VM et CT | `vm-201-disk-0` |

L'**état** d'une ligne est le pire niveau des alertes de santé qui la concernent : volume plein, SMART en échec, secteurs réalloués, température, usure, membre d'un RAID en erreur, OSD `down` ou `out`, check Ceph. Une alerte acceptée ne compte plus. L'espace utilisé d'un stockage Proxmox VE ou d'un disque de CT se colore avec les seuils de volume de la santé. Ces deux lignes n'ont pas d'alerte de santé propre. La barre d'espace porte les deux seuils (attention, alerte) de l'hôte.

Un disque physique n'a pas de barre d'espace : il porte « N volumes », « membre de md0 », « parité » ou « OSD osd.2 ». Un disque découpé en plusieurs volumes (LVM, partitions) n'a pas d'espace utilisé qui ait un sens. Le remplissage se lit sur ses volumes. La page ne calcule pas de date de remplissage (« plein dans X jours »). Cette information n'existe que pour les datastores du PBS.

## En-tête

- **Matrice site × nature** : une case par site et par nature (Volumes, Disques, RAID / Ceph, VM / CT), avec le nombre de lignes et la couleur de la pire. Un clic sur une case filtre la liste sur ce site et cette nature. Un clic sur un site ou une colonne filtre sur l'un des deux. Un second clic retire le filtre.
- **À surveiller** : les lignes en alerte puis en attention (8 au plus), avec la raison. Le nom de l'hôte ouvre sa fiche.

## Liste

Filtres : texte (nom, modèle, n° de série, périphérique), site, hôte, nature, état. Tous sont gardés dans l'adresse de la page. Chaque colonne se trie, et les valeurs absentes restent en fin de liste. Le tri par défaut est l'état, du pire au meilleur.

La température d'un disque en veille est la dernière connue (badge **Veille** dans la colonne SMART). La colonne **Usure / réalloués** montre l'usure NVMe ou les secteurs réalloués, puis l'âge du disque (heures de fonctionnement SMART).

### Vue hiérarchique

L'interrupteur **Vue hiérarchique** range les lignes en arbre :

- array RAID (mdadm, Unraid) → disques membres → volumes qu'ils portent ;
- cluster Ceph → pool RBD → disques des VM et CT → volumes des hôtes liés à ces VM et CT, puis disques des OSD ;
- stockage Proxmox VE → disques des VM et CT qu'il porte ;
- disque physique → ses volumes.

Un groupe se trie par la pire ligne qu'il contient. Avec un filtre, les ancêtres d'une ligne retenue restent affichés pour garder l'arbre lisible.

### Liens entre lignes

- **Volume → disque** : l'agent suit `/sys/class/block` (partition → disque, puis les `slaves` d'un volume LVM, dm-crypt ou mdadm). Un volume sur un array mdadm se range sous l'array. Un volume posé sur un seul disque connu se range sous ce disque.
- **OSD → disque** : `ceph osd metadata` donne les périphériques de chaque OSD du nœud.
- **Disque de VM / CT → hôte** : le lien hôte ↔ VM/CT de Proxmox VE (même adresse MAC). Le volume racine de l'hôte se range sous le disque de démarrage de sa VM ou de son CT.

## API

`GET /api/disks` (tous les profils) renvoie ce que `GET /api/hosts` ne porte pas :

- `thresholds` : par hôte, les seuils de santé résolus (`diskWarning`, `diskAlert`, `temperatureWarning`, `temperatureAlert`, `wearWarning`, `wearAlert`) ;
- `clusters` : par cluster Proxmox VE, ses nœuds, son dernier relevé et ses **stockages** (`storage`, `node` ou `null` pour un stockage partagé, `type`, `used`, `total` en octets) ;
- `guests` : VM et CT (cluster, `vmid`, `type`, nœud, nom, état, `hostId` lié ou `null`) avec leurs **disques** (`key` comme `scsi0` ou `rootfs`, `storage`, `volume`, `sizeBytes`) et, pour un CT, l'espace utilisé (`diskUsed`).

La page assemble le reste à partir de la santé des hôtes : volumes (`disks` : disques physiques sous le volume), SMART (`sizeBytes`, `protocol`, `rotationRate`, `powerOnHours`), RAID et Ceph (`osds[].devices`).

## Prérequis

- Les nouveaux champs de l'agent (disques sous un volume, taille et âge SMART, disques des OSD) demandent l'**agent à jour**. Avant cela, les lignes existent mais sans ces liens ni ces colonnes.
- Les disques physiques n'apparaissent que si SMART est suivi sur l'hôte ([opt-in](sante.md#smart)) ou s'ils sont membres d'un RAID ou d'un OSD.
- Les stockages et les disques des VM et CT viennent du relevé du [rôle Cluster Proxmox VE](proxmox-ve.md) (jeton `PVEAuditor`, aucun droit en plus).
