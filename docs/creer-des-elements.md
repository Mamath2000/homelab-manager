---
title: Créer des éléments
description: Où et comment créer chaque élément de Homelab Manager — hôtes, sites et tags, équipements, sondes, rôles, sauvegardes, comptes et clés d'API
sidebar_position: 0.7
---

# Créer des éléments

Le guide pratique : pour chaque élément, **où cliquer**, **ce qu'il faut savoir avant**, et **le profil requis**. Les détails techniques sont dans la page de chaque sujet.

| Élément | Où | Profil | Détail |
|---|---|---|---|
| [Site](#site-et-tag) | Paramètres › Sites | admin | [Configuration](configuration.md) |
| [Tag](#site-et-tag) | Paramètres › Tags, ou fiche d'un hôte | admin | |
| [Hôte](#hôte) | bouton **Ajouter un hôte** | admin | [Installation](installation.md#les-agents) |
| [Équipement](#équipement) | Équipements › **Ajouter** | admin | [Équipements](equipements.md) |
| [Sonde](#sonde) | fiche d'un hôte ou d'un équipement › **Sondes** | admin | [Sondes](sondes.md) |
| [Rôle](#rôle) | Paramètres › Rôles › **Déclarer un rôle** | admin | [Rôles du hub](roles.md) |
| [Sauvegarde](#sauvegarde) | fiche d'un hôte › **Sauvegardes** › **+ Sauvegarde** | admin | [Sauvegardes](sauvegardes.md) |
| [Compte](#compte-et-clé-dapi) | Comptes | admin (`superadmin` pour les comptes seuls) | [Comptes et profils](comptes.md) |

Les créations se font **sans confirmation** ; les suppressions en demandent une.

## Site et tag

Les sites se décrivent dans **Paramètres › Sites** : un nom, un type (**Principal**, **VPN**, **Externe**) et un ordre d'affichage. Un hôte choisit son site dans sa fiche. Les sites **externes** d'un seul hôte sont réunis dans une carte du tableau de bord.

Les tags se créent dans **Paramètres › Tags** ou sur place, depuis la fiche d'un hôte, avec une couleur. Ils servent de filtres dans la liste des hôtes.

## Hôte

1. **Ajouter un hôte** : nom, site, tags.
2. Copie la commande d'installation et lance-la **en root** sur la machine. Elle épingle la clé du hub, et son code est à usage unique, valable 1 h.
3. L'hôte passe **En ligne** en quelques secondes.

Selon la machine, d'autres onglets proposent la bonne méthode : **Home Assistant OS** (application), **Unraid**, **Windows**, WSL2. Sur Proxmox VE, l'agent peut s'installer dans un CT ou un nœud **depuis l'inventaire**, sans rien copier ([Proxmox VE](proxmox-ve.md#installer-lagent-depuis-linventaire)).

Ensuite, l'engrenage **Options** règle l'identité, l'itinérance (poste qui s'absente), les mises à jour de sécurité automatiques, le niveau de détail dans Home Assistant, et propose une nouvelle commande d'installation, la révocation de l'agent et la suppression.

### Mises à jour de sécurité automatiques

Case **Mises à jour de sécurité automatiques** des options (section *Identité et comportement*, hôtes Debian / Ubuntu avec un agent à jour, capacité `apt_auto`). Le choix se fait hôte par hôte, décoché par défaut.

| Case | Effet sur l'hôte (job `apt_auto_set`) |
|---|---|
| Cochée | installe `unattended-upgrades` s'il manque (sans l'activation de la distribution), puis écrit `/etc/apt/apt.conf.d/52homelab-unattended-upgrades` : dépôts de sécurité seulement (les listes de la distribution, qui comprennent les mises à jour de version mineure sur Debian, sont vidées), passage quotidien, **jamais de redémarrage automatique** |
| Décochée | retire ce fichier ; l'hôte revient à sa propre configuration |

- Le choix est appliqué à l'enregistrement ; un hôte hors ligne le reçoit à son retour. Le hub compare la case à l'état relevé par l'agent et relance le job si l'hôte s'en écarte. Un essai qui a échoué n'est pas répété tout seul : enregistrer les options à nouveau le relance.
- Nœuds Proxmox VE / PBS : la case est proposée avec un avertissement. Seuls les correctifs de sécurité Debian sont concernés (ni le noyau Proxmox ni qemu).
- Un noyau ou une bibliothèque installé automatiquement lève l'alerte **redémarrage requis** habituelle.
- Panneau **Paquets** de la fiche : une icône bouclier dans le titre donne l'état réel (vert : actif et géré ; gris : `unattended-upgrades` actif hors Homelab Manager, par la configuration de la distribution ; orange : choisi mais pas encore appliqué, ou en cours de retrait). La liste repliée **Installées automatiquement** donne les paquets installés par `unattended-upgrade` sur 30 jours (50 au plus), avec leur version et leur date, lus dans `/var/log/apt/history.log`.

## Équipement

Pour ce qui n'a pas d'agent. **Équipements › Ajouter** : nom (unique sur son site), type (Gateway, Switch, Point d'accès, Coordinateur, Passerelle, Module domotique, Autre), site, adresse IP, **équipement amont** (le switch auquel il est branché) et la case **créer une sonde ping**. Un équipement sans sonde n'est pas suivi : il reste gris.

Avec un contrôleur Omada déclaré comme rôle, ses appareils sont créés et tenus à jour automatiquement ([Omada](equipements.md#omada)).

## Sonde

Une sonde vérifie le **service rendu**, pas seulement la présence : ping, port TCP, page HTTP (code, mot-clé), message MQTT (disponibilité Zigbee2MQTT, dernier mot ESPHome).

Sur la fiche d'un hôte (ou d'un équipement) : **Sondes › Ajouter une sonde**, en quatre étapes :

1. **Type et nom** ;
2. **Origine** : le hub, ou pour un ping un hôte avec agent (utile pour éprouver un lien entre deux sites) ;
3. **Cible** : adresse, port, URL, topic ;
4. **Options et test** : stack Docker éventuelle, intervalle (60 s par défaut), délai maximal, nouvelles tentatives, puis **une mesure immédiate sans enregistrer**.

Un échec réseau (connexion refusée, mauvais code) donne « hors service » ; « inconnu » est réservé aux cas où la mesure elle-même est impossible (broker injoignable). Pour la sonde MQTT, déclare d'abord le broker comme [rôle](#rôle).

## Rôle

Un rôle est une **fonction du hub portée par un hôte**. **Paramètres › Rôles › Déclarer un rôle** ouvre un assistant **Type › Hôte › Paramètres › Test**, et l'enregistrement exige un **test de connexion réussi** :

| Type | Ce qu'il permet | Prérequis |
|---|---|---|
| **PBS principal** | suivre les sauvegardes du Proxmox Backup Server | un hôte avec agent portant le PBS (installé ou en conteneur) |
| **PBS hors site** | copier des sauvegardes choisies vers un PBS distant | le PBS principal d'abord |
| **Cluster Proxmox VE** | inventaire des VM et CT, jobs vzdump, rattachement des sauvegardes | un nœud avec agent |
| **Broker MQTT** | sondes MQTT, pont Home Assistant | un hôte avec agent où le broker écoute (détecté, à déclarer d'un clic) |
| **Contrôleur Omada** | équipements synchronisés, sondes VPN | un hôte (Docker) ou un équipement avec adresse IP |

Les jetons (PBS, Proxmox VE) ne se copient jamais à la main : **l'agent** de l'hôte les crée, avec des droits minimum, et le secret n'est jamais affiché. Un rôle utilisé par une sonde ne se supprime pas tant que la sonde existe.

## Sauvegarde

Il y a deux familles :

- **suivies** : les jobs Proxmox VE et les sauvegardes de Home Assistant sont **découverts** une fois le rôle déclaré, rien à créer ;
- **créées** dans Homelab Manager : sur la fiche d'un hôte, **Sauvegardes › + Sauvegarde**. L'agent exécute et planifie lui-même, le PBS confirme.

Pour une sauvegarde créée dans l'interface :

1. installer le **client PBS** sur l'hôte (APT ou conteneur Docker, un clic) ;
2. **Accès PBS › Créer le jeton** de l'hôte (droit d'écriture sur son seul namespace `Hosts`) ;
3. **Ajouter** : type **Répertoires**, **Base PostgreSQL** ou **Base MongoDB**, nom, contenu, exclusions, datastore, planification (`03:00`, `sun 01:00`, `mon..fri 22:30`…). **Estimer la taille** donne le volume avant de lancer.

Une sauvegarde peut aussi se déclencher **à la connexion de l'agent** (poste nomade), et être rejouée une fois après échec. La rétention n'est pas choisie par job : c'est l'élagage du PBS. Pour une copie hors site, ouvre la pastille **détail** de la sauvegarde et **Activer la copie**. Tout est dans [Sauvegardes](sauvegardes.md).

## Compte et clé d'API

**Comptes › Nouveau compte** : identifiant, nom, profil. Le mot de passe temporaire est affiché **une seule fois** ; l'utilisateur en choisit un à sa première connexion. L'option **Aucun mot de passe** crée un compte réservé aux services, qui s'utilise avec une **clé d'API** générée dans **Modifier** (une clé par service, révocable seule). Une clé a les droits du profil du compte : un `viewer` suffit pour un affichage ([API](api.md)).
