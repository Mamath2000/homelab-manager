---
title: Proxmox VE
description: Inventaire d'un cluster Proxmox VE dans Homelab Manager (nœuds, VM et CT), lien avec les hôtes par adresse MAC, sauvegardes vzdump quel que soit le stockage, lien perdu, droits du jeton
sidebar_position: 3.65
---

# Proxmox VE

Un cluster Proxmox VE se déclare comme un **rôle** (`Cluster Proxmox VE`, Paramètres › Rôles) porté par l'hôte d'un de ses nœuds, avec un jeton `PVEAuditor` en lecture seule (création du jeton : [Sauvegardes](sauvegardes.md#jeton-de-proxmox-ve--créé-par-lagent-dun-nœud)). Rien n'est jamais écrit sur Proxmox. Un PBS n'est pas nécessaire.

Toutes les 15 minutes, le hub relit le cluster : nœuds, VM et CT (hors modèles) avec leur état, adresses MAC, jobs de sauvegarde, stockages et dernières tâches vzdump.

## Inventaire (Paramètres › Proxmox VE)

L'onglet apparaît dès qu'un rôle `Cluster Proxmox VE` existe (administrateurs). Il montre le cluster (adresse, hôte lecteur, dernier relevé et son erreur éventuelle), puis **par nœud** (avec son agent, ou « non géré ») ses VM et CT : identifiant, nom, état Proxmox, hôte lié ou **non géré**, jobs programmés.

L'inventaire est relu à chaque relevé : une ligne n'est ni un hôte ni un équipement. Il ne montre ni santé, ni résultats, ni snapshots : c'est le sujet de la fiche hôte. Une VM ou un CT **non géré** (aucun hôte ne porte une de ses adresses MAC) n'apparaît que dans cet onglet, sans alerte ; ses éventuelles sauvegardes PBS restent dans les [orphelines](sauvegardes.md#sauvegardes-externes--rattachement-manuel).

## Lien avec un hôte

Les hôtes vivent indépendamment de Proxmox. Quand l'adresse MAC d'un agent est celle d'**une seule** VM ou d'**un seul** CT, l'hôte y est lié automatiquement. Une MAC partagée (clones) ne lie rien : la ligne est marquée **MAC ambiguë**. Un nœud hors ligne ne coupe pas les liens de ses VM et CT (les MAC du relevé précédent sont gardées).

Sur la fiche de l'hôte lié : VM ou CT et nœud (`CT 100 · pve1`), jobs vzdump, groupes PBS rattachés, alerte « couvert par aucun job » si aucun job actif ne le couvre.

## Sauvegardes vzdump d'un hôte lié

Elles sont affichées et alertées (échec de la dernière tâche, retard) **quel que soit le stockage cible** : PBS suivi, `local`, NFS ou autre PBS. Une ligne par stockage cible, avec son propre résultat (le stockage est lu dans le journal de la tâche).

Hors du PBS suivi, ces sauvegardes ne sont ni copiées sur le PBS de secours, ni montables, ni retirées par la déconnexion du PBS (comme celles de Home Assistant OS).

:::note Archives non lisibles
Proxmox ne montre les archives d'un stockage qu'à un jeton qui a `VM.Backup` sur la VM et `Datastore.AllocateSpace` sur le stockage ; `PVEAuditor` ne les a pas. Le hub date alors la dernière sauvegarde de la **dernière tâche vzdump réussie**, n'affiche pas de nombre de snapshots (« archives non lisibles » dans la liste, rien dans la pastille détail) et alerte comme pour les autres. Donner ces droits au jeton fait apparaître la vraie liste, mais ce sont des droits d'écriture : ce n'est pas le choix par défaut.
:::

Une planification `yearly` n'est pas reconnue : pas de seuil, donc pas d'alerte de retard pour ce job (voir [Retard](sauvegardes.md#retard)).

## Lien perdu

Si la VM ou le CT disparaît de l'inventaire, ou le rôle est retiré, le lien est **mis de côté sur l'hôte** (avec sa conf et sa date). La fiche affiche « Lien Proxmox VE perdu il y a… » et ses groupes PBS passent en **non rattachés**. Rien n'est effacé automatiquement.

| Bouton | Effet |
|---|---|
| **Rétablir** | quand l'inventaire correspond de nouveau (même cluster, même vmid) |
| **Lier à CT n** | l'hôte correspond par MAC à un autre CT (restauration sous un nouveau vmid) : remplace le lien mis de côté |
| **Oublier** (confirmation) | abandonne le lien mis de côté ; un rapprochement par MAC redevient un premier lien |

Un hôte supprimé emporte son lien mis de côté ; réinstallé, c'est un nouvel hôte, lié de nouveau par sa MAC.

## API

Routes réservées aux administrateurs : `GET /api/settings/pve/inventory` (clusters, nœuds, VM et CT avec leur hôte), `POST /api/hosts/:id/pve/restore` (Rétablir / Lier à), `DELETE /api/hosts/:id/pve/lost` (Oublier).
