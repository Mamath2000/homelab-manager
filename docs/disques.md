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
| **Disque** | disques SMART suivis, membres d'un RAID ou d'un pool Unraid, disques d'un OSD Ceph, disques sous un volume ou un groupe de volumes LVM | Samsung PM983 1.92TB |
| **RAID** | arrays mdadm, array et pools Unraid | `/dev/md0`, Array Unraid, Pool speed |
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

L'interrupteur **Vue hiérarchique** range les lignes en arbre. La chaîne complète est la suivante, chaque niveau étant facultatif :

```text
groupe              RAID mdadm · Array Unraid · Pool Unraid · Ceph
└ disque physique   relevé SMART, ou « pas de relevé SMART »
  └ volume          système de fichiers monté de l'hôte (partition, volume LVM, md…)
    └ stockage PVE  dir sous son volume ; lvm / lvmthin directement sous le disque
      └ disque VM / CT  image raw, RBD, volume LVM
        └ volume    système de fichiers vu dans la VM ou le CT
```

LVM n'est pas une ligne. Un **volume** est toujours un système de fichiers monté. Le groupe de volumes sert seulement à placer un stockage `lvm` ou `lvmthin`. Selon le groupe :

- **array mdadm** : disques membres et volume monté sur `/dev/mdX`, tous deux sous l'array ;
- **array Unraid** : array → disque `diskN` → volume `/mnt/diskN` ;
- **pool Unraid** (btrfs, ZFS) : ses disques et le volume `/mnt/<pool>` sous la ligne du pool, qui porte ses alertes (disque manquant, état) ;
- **Ceph** : cluster → disques des OSD, et cluster → pool RBD → disques des VM et CT → volumes des hôtes liés ;
- **stockage Proxmox VE** non Ceph : sous le volume ou le disque de son nœud qui le porte, puis les disques des VM et CT qu'il porte ;
- **disque physique** : ses volumes.

Un disque de VM ou de CT qui ne porte qu'**un seul volume** (le rootfs d'un CT, en général) n'a qu'une ligne : le disque garde sa taille (celle de l'image), et prend l'espace utilisé, l'état et le système de fichiers mesurés par l'agent dans la VM ou le CT. Le point de montage s'ajoute au sous-titre (`CT 253 · adguard · rootfs → /`). Le système de fichiers est un peu plus petit que l'image : ext4 ne compte pas son journal ni ses tables d'inodes.

Un groupe se trie par la pire ligne qu'il contient. Avec un filtre, les ancêtres d'une ligne retenue restent affichés pour garder l'arbre lisible.

### Liens entre lignes

- **Volume → disque** : l'agent suit `/sys/class/block` (partition → disque, puis les `slaves` d'un volume LVM, dm-crypt ou mdadm). Sous Windows, il demande à Windows les disques d'une lettre de lecteur (`IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS`) et les nomme comme smartctl (`PhysicalDrive0` → `/dev/sda`). Un volume sur un array mdadm se range sous l'array. Un volume posé sur un seul disque se range sous ce disque. Si ce disque n'est pas suivi en SMART, une ligne « pas de relevé SMART » est créée. Exception : sur une VM ou un CT lié, le volume se range sous le disque de la VM ou du CT.
- **Disque NVMe** : smartctl le nomme par son contrôleur (`/dev/nvme0`), sysfs, mdadm et Ceph par son namespace (`/dev/nvme0n1`). Les deux désignent le même disque.
- **Unraid** : un volume `/mnt/<pool>` se range sous son pool, un volume sur `/dev/mdN` sous le disque `diskN` de l'array. Ni l'un ni l'autre ne se lit dans sysfs (pilote md propre à Unraid, btrfs sur plusieurs disques).
- **Stockage → volume ou disque** : un stockage `dir` se range sous le volume de son nœud dont le point de montage contient son chemin (le plus long). Un stockage `lvm` ou `lvmthin` se range sous le disque de son groupe de volumes, quand ce groupe n'est que sur un disque. L'agent lit les groupes de volumes dans sysfs (volumes logiques actifs, `dm/uuid` en `LVM-`).
- **OSD → disque** : `ceph osd metadata` donne les périphériques de chaque OSD du nœud.
- **Disque de VM / CT → hôte** : le lien hôte ↔ VM/CT de Proxmox VE (même adresse MAC). Pour un CT, chaque volume se range sous le disque monté au même endroit (`/` pour le rootfs, `mp=` d'un point de montage). Pour une VM, la configuration ne dit pas où chaque disque est monté : tous ses volumes se rangent sous son disque de démarrage.

## API

`GET /api/disks` (tous les profils) renvoie ce que `GET /api/hosts` ne porte pas :

- `thresholds` : par hôte, les seuils de santé résolus (`diskWarning`, `diskAlert`, `temperatureWarning`, `temperatureAlert`, `wearWarning`, `wearAlert`) ;
- `clusters` : par cluster Proxmox VE, ses nœuds, son dernier relevé et ses **stockages** (`storage`, `node` ou `null` pour un stockage partagé, `type`, `used`, `total` en octets, `path` d'un stockage `dir`, `vgname` d'un stockage `lvm` ou `lvmthin`) ;
- `guests` : VM et CT (cluster, `vmid`, `type`, nœud, nom, état, `hostId` lié ou `null`) avec leurs **disques** (`key` comme `scsi0` ou `rootfs`, `storage`, `volume`, `sizeBytes`, et pour un CT `mountpoint`) et, pour un CT, l'espace utilisé (`diskUsed`).

La page assemble le reste à partir de la santé des hôtes : volumes (`disks` : disques physiques sous le volume), groupes de volumes LVM (`volumeGroups` : `name`, `disks`), SMART (`sizeBytes`, `protocol`, `rotationRate`, `powerOnHours`), RAID et Ceph (`osds[].devices`).

## Prérequis

- Les nouveaux champs de l'agent (disques sous un volume, taille et âge SMART, disques des OSD, disques des volumes Windows, groupes de volumes LVM) demandent l'**agent à jour**. Avant cela, les lignes existent mais sans ces liens ni ces colonnes.
- Sans SMART suivi sur l'hôte ([opt-in](sante.md#smart)), un disque physique apparaît sans valeurs SMART s'il porte un volume, est membre d'un RAID, d'un pool Unraid ou d'un OSD, ou porte un groupe de volumes LVM.
- Les chemins des stockages et les points de montage des CT viennent du relevé Proxmox VE suivant la mise à jour du hub.
- Les stockages et les disques des VM et CT viennent du relevé du [rôle Cluster Proxmox VE](proxmox-ve.md) (jeton `PVEAuditor`, aucun droit en plus).
