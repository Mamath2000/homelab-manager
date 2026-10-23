---
title: Santé
description: Suivi de la santé des hôtes (CPU, mémoire, charge, volumes, disques SMART opt-in, RAID mdadm, array et pools Unraid, Ceph), fréquences de collecte, rétention 48 h, seuils d'alerte réglables et acceptation d'une alerte, par plateforme
sidebar_position: 3.6
---

# Santé

L'écran **Santé** donne une vue d'ensemble des hôtes compatibles : CPU, mémoire, charge, volumes et, sur option, disques SMART. La fiche de chaque hôte affiche ses mesures détaillées et, si l'agent l'annonce, permet de choisir les disques SMART suivis.

## Collecte et rétention

Les agents Linux, Windows et Home Assistant OS envoient des rapports typés, chacun à sa propre fréquence :

| Mesures | Défaut | Plage réglable |
|---|---|---|
| CPU, mémoire, charge Unix | 30 s | 10 s – 1 h |
| Usage des volumes | 5 min | 1 min – 24 h |
| RAID (mdadm, Unraid, Ceph) | avec les volumes | — |
| SMART | 24 h | 10 min – 30 jours |

Les fréquences se règlent globalement dans **Paramètres › Santé**.

MongoDB stocke les échantillons dans `healthMetrics`, indexés par hôte, catégorie et horodatage. Un index TTL supprime les mesures après **48 h**. La courbe de l'interface montre la dernière heure : il n'y a pas d'historique long terme.

### Volumes

Sous Unix, les montages `loop` (images, conteneurs), les pseudo-filesystems (`overlay`, `tmpfs`, `proc`…) et `/boot/efi` ne sont pas listés. Les partitions et volumes RAID restent suivis. Une machine virtuelle qui présente son disque virtuel comme un disque local ne permet pas à l'agent de savoir si le stockage sous-jacent est physique.

## SMART

SMART est volontairement **opt-in, hôte par hôte**.

- Sur un agent Linux qui annonce la capacité `smart`, la fiche de l'hôte permet de saisir les périphériques physiques à suivre (par exemple `/dev/sda` ou `/dev/nvme0`). Seuls ces chemins sont transmis à l'agent et interrogés avec `smartctl` ; aucune détection ni requête SMART automatique n'est faite.
- Le paquet `smartmontools` doit être installé sur l'hôte et l'agent doit avoir les droits nécessaires.
- Pour les hôtes que l'agent identifie comme virtualisés, la configuration SMART n'est pas proposée et le hub n'envoie aucun périphérique à interroger.

Les rapports affichent l'état global, la température, les secteurs réalloués et l'usure NVMe quand le disque les fournit. Les VM et LXC sans accès au périphérique physique, et les contrôleurs RAID que `smartctl` n'expose pas, ne remontent pas ces détails.

## RAID

Le bloc **RAID** de la fiche regroupe trois sources, collectées au rythme des volumes. Rien à activer : la capacité `raid` n'est annoncée, et le bloc n'apparaît, que sur un hôte qui a au moins un array mdadm, un array Unraid ou un cluster Ceph. Les conteneurs (LXC, Docker…) voient les arrays de leur hôte : leurs rapports sont ignorés. Tous les niveaux RAID sont immédiats et sans seuil réglable.

### RAID logiciel (mdadm)

Sur Linux, l'agent lit l'état des arrays `md` dans `/sys/block/mdX/md/` (lecture passive, sans paquet ni droit particulier). Le driver md propre à Unraid n'y apparaît pas : il a sa propre section.

Par array : niveau, état, disques actifs / attendus, synchronisation en cours avec sa progression, incohérences (`mismatch_cnt`) et, par membre, état et erreurs de lecture corrigées par md.

| Situation | Niveau |
|---|---|
| Array dégradé, membre en échec (`faulty`), array arrêté (`inactive`, `readonly`…) | alerte |
| Array en `read-auto` | avertissement |
| Reconstruction, resynchro ou remodelage en cours | avertissement |
| Incohérences relevées par le dernier contrôle | avertissement |
| Erreurs de lecture corrigées sur un membre | avertissement |
| Contrôle périodique (`check` / `repair`, timers `mdcheck`) | affiché, sans alerte |

Le compteur d'erreurs corrigées n'est jamais remis à zéro par le noyau : l'avertissement porte sa valeur. Une fois accepté, il ne compte plus ; si le compteur augmente, un nouvel avertissement apparaît.

### Unraid (array et pools)

Sur Unraid, l'agent lit les fichiers d'état d'emhttp, `/var/local/emhttp/var.ini` et `disks.ini` (lecture passive), et `btrfs device stats` pour les pools btrfs (`zpool list` pour un pool ZFS). Il remonte l'état de l'array, chaque disque de parité et de données avec son statut et ses erreurs, le contrôle de parité en cours et le dernier contrôle (date, durée, erreurs), et chaque pool avec ses disques et leurs erreurs.

Les emplacements vides (data sans disque, seconde parité non assignée) sont ignorés : les compteurs globaux d'Unraid (`mdNumDisabled`, `mdNumInvalid`) les comptent, ils ne servent donc pas aux alertes.

| Situation | Niveau |
|---|---|
| Array non démarré | alerte |
| Disque désactivé ou émulé, manquant, invalide, mauvais disque | alerte |
| Pool avec un disque manquant, pool ZFS non `ONLINE` | alerte |
| Erreurs au dernier contrôle de parité | alerte |
| Reconstruction en cours | avertissement |
| Erreurs d'entrée-sortie d'un disque, erreurs btrfs d'un disque de pool | avertissement |
| Dernier contrôle de parité interrompu | avertissement |
| Nouveau disque pas encore intégré | avertissement |
| Contrôle de parité en cours | affiché, sans alerte |

Comme pour mdadm, les compteurs d'erreurs font partie de l'avertissement : une hausse le fait réapparaître après acceptation. L'avertissement du dernier contrôle porte sur ce contrôle-là : le suivant repart de zéro.

### Ceph

Sur un nœud Proxmox VE avec Ceph (`/etc/pve/ceph.conf` et la commande `ceph`), l'agent interroge le cluster avec le trousseau admin de root : `ceph status`, `ceph health detail` et `ceph osd tree`, bornés à 20 s. Sans réponse dans ce délai (perte du quorum des moniteurs, par exemple), Ceph est signalé injoignable.

Chaque nœud remonte l'état du **cluster entier** (santé, checks, OSD up/in, PG `active+clean`, remplissage) et les **OSD qu'il héberge**. Le bloc Ceph affiche le nom du cluster Proxmox du nœud.

| Situation | Niveau | Où |
|---|---|---|
| `HEALTH_ERR` (par check) | alerte | tous les nœuds |
| `HEALTH_WARN` (par check) | avertissement | tous les nœuds |
| Ceph injoignable | alerte | nœud concerné |
| OSD `down` | alerte | nœud qui l'héberge |
| OSD `out` | avertissement | nœud qui l'héberge |

Les checks mis en sourdine dans Ceph (`ceph health mute`) sont affichés sans alerter. Un check du cluster porte la même alerte sur chaque nœud : l'accepter sur un nœud l'accepte sur tous les nœuds du même cluster Ceph (même `fsid`) où il est actif.

## Alertes

La santé est un [domaine d'alerte](alertes.md) à part entière (`health`, libellé **Santé**) : ligne dans la frise des 30 jours de la fiche, carré dans la tuile de l'hôte et filtre de la frise du tableau de bord. Comme APT, Docker ou l'onduleur, il n'est lu que tant que l'agent est connecté : hors ligne, il est inconnu (gris) et ne colore ni l'hôte ni le site.

Seuils par défaut, réglables dans **Paramètres › Santé** (avertissement / alerte) :

| Mesure | Avertissement | Alerte |
|---|---:|---:|
| CPU | 75 % | 90 % |
| Mémoire | 80 % | 90 % |
| Volume | 75 % | 90 % |
| Température SMART | 60 °C | 70 °C |
| Usure NVMe | 70 % | 85 % |

Un secteur réalloué est signalé immédiatement, quels que soient les seuils. Les niveaux RAID sont décrits [plus haut](#raid).

### Durée avant déclenchement

La durée se règle séparément pour les mesures système (CPU, mémoire) et pour SMART. Par défaut :

- CPU et mémoire : 5 minutes continues au-dessus du seuil ;
- volumes : immédiat dès le franchissement du seuil ;
- SMART : immédiat ;
- RAID : immédiat.

Une durée de 0 signifie immédiat pour les catégories temporisées. Une alerte active garde une hystérésis de 5 points pour éviter les oscillations près du seuil.

### Accepter une alerte

Une alerte connue et assumée peut être **acceptée** depuis l'écran Santé : elle reste affichée, marquée comme acceptée, mais ne compte plus dans l'état de l'hôte. L'acceptation vaut pour le niveau où elle a été faite : un avertissement accepté qui passe en alerte est signalé de nouveau.

## Home Assistant

Avec l'[intégration Home Assistant](home-assistant.md), les alertes du domaine Santé remontent comme celles des autres domaines, sur l'appareil de l'hôte (avertissement ou critique selon le niveau).

## Limites de plateforme

- **Windows** collecte CPU, mémoire et volumes ; la charge Unix, SMART et le RAID ne s'appliquent pas.
- **Home Assistant OS** s'appuie sur les statistiques Linux visibles dans l'add-on pour CPU, mémoire et charge, et sur `/host/info` de l'API Supervisor pour l'occupation du disque de données. SMART n'y est pas activé par défaut.
- **Unix** : la charge `load 1/5/15` n'existe que sur ces plateformes.
- Une métrique absente d'une plateforme ou d'un agent reste vide, jamais remplacée par zéro.
