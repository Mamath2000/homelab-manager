---
title: Les notions clés
description: Hub, agent, hôte, équipement, site, tag, rôle, profil, sonde, domaine, sauvegarde — le vocabulaire de Homelab Manager en une page
sidebar_position: 0.6
---

# Les notions clés

Homelab Manager a peu de concepts, mais certains mots ont un sens précis (« rôle » n'est pas « profil »).

## Les acteurs

| Notion | C'est… |
|---|---|
| **Hub** | l'application, un conteneur Docker avec sa base MongoDB. Il sert l'interface, calcule tous les états, et exécute ce qui n'a pas besoin d'agent (sondes, relevé des API Proxmox, PBS, Omada). |
| **Agent** | un petit binaire installé sur chaque machine, qui **se connecte au hub** (rien à ouvrir sur l'hôte), remonte l'état local et n'exécute qu'une liste fixe d'actions. Un certificat par agent. |
| **Hôte** | une machine **avec agent** : serveur, VM, LXC, poste Windows, Home Assistant OS. |
| **Équipement** | un appareil **sans agent**, suivi par des sondes : switch, point d'accès, passerelle, coordinateur Zigbee, module ESPHome… ([Équipements](equipements.md)). |
| **Site** | un lieu : maison, résidence secondaire, bureau. Il regroupe hôtes et équipements et prend le pire état des siens. |
| **Tag** | une étiquette colorée, plusieurs par hôte, pour filtrer. |

## Ce que le hub fait au travers d'un élément

| Notion | C'est… |
|---|---|
| **Rôle** | ce que le hub fait **au travers d'un hôte** : écouter un broker MQTT, relever un cluster Proxmox VE, suivre le PBS principal ou hors site, synchroniser un contrôleur Omada, lire les journaux d'un serveur de logs. Déclaré dans Paramètres › Rôles ([Rôles du hub](roles.md)). |
| **Sonde** | une vérification faite de l'extérieur : ping, port TCP, page HTTP, message MQTT, tunnel VPN ([Sondes](sondes.md)). |
| **Sauvegarde** | une ligne suivie dans la page Sauvegardes : un groupe du PBS, un job vzdump, une sauvegarde de Home Assistant. Rattachée à un hôte, elle a une planification, un retard, une frise ([Suivi des sauvegardes](suivi-des-sauvegardes.md)). |

## Les droits

Un **profil** est ce qu'un **compte** a le droit de faire : `admin` (tout), `operator` (lance les actions, ne configure rien), `viewer` (lecture seule). Un compte peut n'avoir aucun mot de passe et servir uniquement avec une **clé d'API** (Homepage, scripts). Le compte `superadmin` ne gère que les comptes. Voir [Comptes et profils](comptes.md).

## Les états

Un seul calcul, fait par le hub, donne l'état de tout ce qui est suivi :

```
élément → domaine → hôte → site
```

- Un **élément** porte un état : une stack, une sauvegarde, une sonde, un problème d'onduleur.
- Un **domaine** regroupe ses éléments : Connexion, Mises à jour, Docker, Sauvegardes, Copie externe, Onduleur, Services…
- Chaque niveau prend le **pire** de ceux du dessous : ok, avertissement (orange) ou alerte (rouge). Gris : pas suivi ou inconnu.

Le tableau de bord, la fiche hôte, la frise de 30 jours, les compteurs et Home Assistant lisent tous ce même calcul : ils ne se contredisent jamais. Détail : [Alertes et statuts](alertes.md).

## Qui voit quoi

```
navigateur ──► hub ◄── agents (hôtes)
                │
                ├──► API Proxmox VE, PBS, Omada, brokers MQTT (via un rôle)
                ├──► serveur de logs ◄── journaux des hôtes (syslog)
                ├──► sondes ping / TCP / HTTP / MQTT
                └──► MQTT ──► Home Assistant (option)
```

Pour la sécurité des échanges : [Sécurité](securite.md).
