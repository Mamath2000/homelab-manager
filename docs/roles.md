---
id: roles
title: Rôles du hub
description: "Ce que le hub peut faire au travers d'un élément du homelab (broker MQTT, cluster Proxmox VE) : déclaration, hôte porteur, test, réaffectation"
sidebar_position: 3.95
---

# Rôles du hub

Un **rôle** est ce que le hub fait au travers d'un élément du homelab : écouter un broker MQTT, relever un cluster Proxmox VE. Chaque rôle est **porté par un hôte** et déclaré par un administrateur dans **Paramètres › Rôles** ; sans rôle, ce qui en dépend est inactif (pas de sonde MQTT, pas de pont Home Assistant, pas d'inventaire Proxmox VE).

:::note Rôles et profils
Les droits d'un compte s'appellent des **profils** (`admin`, `operator`, `viewer`, voir [Comptes et profils](comptes.md)) : le mot « rôle » ne désigne que ce qui est décrit ici.
:::

## Types

| Type | Porteur | Plusieurs ? | Utilisé par |
|---|---|---|---|
| **Broker MQTT** (`mqtt-broker`) | un hôte dont l'agent a détecté un broker en écoute | oui, un par `(hôte, port)` | [sondes MQTT](sondes.md#brokers-mqtt), pont [Home Assistant](home-assistant.md) |
| **Cluster Proxmox VE** (`pve-cluster`) | un nœud (hôte avec la capacité Proxmox VE) | oui, un par cluster | [inventaire](proxmox-ve.md) et [sauvegardes](sauvegardes.md#clusters-proxmox-ve) |
| **Contrôleur Omada** (`omada-controller`) | un **hôte** (contrôleur en Docker, détecté par l'agent sur ses ports de service) ou un **équipement** avec une adresse IP (contrôleur dédié, OC200…) | oui | Paramètres › Omada : [équipements](equipements.md#omada) synchronisés et [sondes VPN](sondes.md#sondes-vpn) |

Le contrôleur Omada est le seul rôle qu'un **équipement** peut porter : il passe par une API (adresse, empreinte du certificat épinglée, application Open API en mode client), sans agent. Sans contrôleur déclaré, l'onglet Paramètres › Omada n'apparaît pas et rien n'est relu.

Un rôle de type broker n'est jamais saisi à la main : l'agent de l'hôte signale ce qu'il voit en écoute, l'administrateur le déclare. Un rôle Cluster Proxmox VE reçoit son jeton `PVEAuditor` de l'agent du nœud porteur (voir [Sauvegardes](sauvegardes.md#jeton-de-proxmox-ve--créé-par-lagent-dun-nœud)).

## Déclarer un rôle

**Paramètres › Rôles › Déclarer un rôle** ouvre un assistant en étapes (**Type › Hôte › Paramètres › Test**). L'enregistrement exige un **test de connexion** réussi ; le mot de passe n'est jamais renvoyé par l'API. Chaque rôle porte un **nom** (son identifiant dans les sondes) et affiche ce qui l'utilise.

Sur la fiche d'un hôte ou d'un équipement, les rôles qu'il porte s'affichent (lien vers Paramètres › Rôles) ; sur un hôte, et un broker détecté par son agent se déclare d'un clic (**Déclarer**, assistant prérempli).

## Réaffecter, supprimer

- **Réaffecter** : modifier le rôle et choisir un autre hôte porteur, paramètres conservés (pour un cluster Proxmox VE, un autre nœud **du même cluster**). Un hôte porteur hors ligne ne déplace rien tout seul : le relevé passe en erreur, comme avant, et la réaffectation reste manuelle.
- **Supprimer** : refusé tant qu'une sonde ou le pont Home Assistant utilise le rôle. Supprimer **un hôte ou un équipement porteur** est refusé tant qu'il porte un rôle (la confirmation de suppression le dit et renvoie vers Paramètres › Rôles).
- Redémarrer ou arrêter un hôte porteur affiche un avertissement qui nomme les rôles concernés.

## Migration

Au premier démarrage d'une version avec les rôles, le hub reprend l'existant sans rien demander :

- les brokers MQTT des anciennes options d'hôte deviennent des rôles (**même identifiant** : les sondes qui les citent continuent de marcher) ;
- les clusters de Paramètres › Sauvegardes deviennent des rôles Cluster Proxmox VE, avec leur jeton ;
- le broker du pont Home Assistant est rattaché au rôle de même adresse et de même compte, sinon il reste « à rattacher » (voir [Home Assistant](home-assistant.md#relier-un-broker)) ;
- le champ `role` des comptes devient `profile` (le champ JSON de `/api/users` et du compte connecté suit).

:::warning Pas de retour en arrière
La migration des comptes est à sens unique : une version antérieure du hub ne retrouverait pas le champ `role` et passerait tous les comptes en `admin`. Sauvegarder la base avant la mise à jour.
:::

## API

Administrateurs seulement, sauf mention contraire.

| Route | Rôle de la route |
|---|---|
| `GET /api/roles` | rôles avec hôte porteur, état de la connexion et `uses` (ce qui les utilise) ; le mot de passe n'est jamais renvoyé |
| `POST /api/roles` | déclarer un rôle (`type`, `carrier`, `name`, `config`) |
| `PUT /api/roles/:id` | modifier ou réaffecter (`carrier`) |
| `DELETE /api/roles/:id` | supprimer (`409` si utilisé) |
| `POST /api/roles/test` | tester la connexion d'un rôle en cours de saisie |

`GET /api/settings/pve` et `/api/settings/pve/*` restent les routes des clusters Proxmox VE (relevé, jeton, test, déplacement) et travaillent sur les rôles.
