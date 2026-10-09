---
title: Home Assistant
description: Publier le homelab dans Home Assistant via MQTT (découverte automatique device-based)
sidebar_position: 3
---

# Home Assistant

Le hub peut publier l'état du homelab sur un broker MQTT, avec la **découverte automatique** de Home Assistant au format *device-based* : un seul message `homeassistant/device/ID/config` par appareil, qui décrit tous ses composants. Les mises à jour et les vérifications se déclenchent aussi depuis Home Assistant.

## Activer l'intégration

Dans l'interface : **Paramètres → Home Assistant (MQTT)**.

| Champ | Rôle |
|---|---|
| Publier le homelab dans Home Assistant | Active ou désactive l'intégration |
| Broker MQTT | `mqtt://IP:1883`, `mqtts://…`, `ws://…` ou `wss://…` |
| Utilisateur / Mot de passe | Identifiants du broker (le mot de passe n'est jamais renvoyé par l'API) |
| Préfixe des topics | Préfixe des états et commandes, `homelab-manager` par défaut |
| Préfixe de découverte | `homeassistant` par défaut |

**Tester la connexion** vérifie que le broker accepte les identifiants, sans rien publier. Une fois enregistrée, la carte d'état indique si le hub est connecté et combien d'appareils sont publiés.

:::info Désactivation
Désactiver l'intégration, ou changer de préfixe, **retire les appareils** de Home Assistant (configurations de découverte vidées).
:::

:::note Stockage
Les paramètres, dont le mot de passe du broker, sont enregistrés dans la base MongoDB du hub.
:::

## Appareils créés

Les appareils sont organisés en hiérarchie (`via_device`) : les **alertes remontent** de chaque composant vers son hôte, puis vers Homelab Manager ; le **détail** reste dans les sous-composants.

```text
Homelab Manager
├── pve1                      (un appareil par hôte)
│   └── pve1 · APT            (sous-composant : paquets système)
├── pbs+omada
│   └── pbs+omada · APT
└── …
```

### Homelab Manager

| Entité | Type |
|---|---|
| Hôtes, Hôtes en ligne | capteurs |
| Mises à jour disponibles, Mises à jour de sécurité | capteurs (totaux de tous les hôtes) |
| Hôtes à mettre à jour, Hôtes à redémarrer, Hôtes à nettoyer | capteurs |
| Alertes | capteur (nombre) ; attributs `critical` et `alerts` (niveau, hôte, composant, message) |
| Problème | capteur binaire, allumé dès qu'une alerte existe |
| Tout vérifier | bouton : `apt-get update` sur les hôtes en ligne |
| Tout mettre à jour | bouton : mise à jour complète des hôtes en ligne qui en ont |

### Un appareil par hôte

| Entité | Type |
|---|---|
| Agent | capteur binaire de connectivité (agent connecté au hub) |
| Redémarrer | bouton (`systemctl reboot` sur l'hôte) |
| Alertes, Problème | alertes de l'agent et de tous les sous-composants de l'hôte |
| Système, Noyau, Adresse IP, Vu | diagnostic |

### Sous-composant APT

| Entité | Type |
|---|---|
| Paquets système | entité `update` : version installée / disponible, résumé des paquets, **installable depuis Home Assistant** (mise à jour complète) |
| Mises à jour, Mises à jour de sécurité | capteurs |
| Redémarrage requis | capteur binaire (problème) |
| Redémarrage après MAJ | capteur : paquets en attente qui demanderont un redémarrage |
| Paquets à nettoyer | capteur : paquets supprimables par `apt autoremove` (liste en attribut `packages`) |
| Nettoyer les paquets | bouton : `apt-get autoremove` |
| Paquets bloqués, Dernière vérification | diagnostic |
| Alertes, Problème | diagnostic : alertes propres aux paquets |
| Rechercher les mises à jour | bouton : `apt-get update` |

### Alertes

| Composant | Niveau | Alerte |
|---|---|---|
| Agent | critique | Agent hors ligne |
| Agent | avertissement | Agent jamais connecté |
| APT | avertissement | Mises à jour de sécurité disponibles |
| APT | avertissement | Redémarrage requis |
| APT | avertissement | Listes de paquets non rafraîchies depuis plus de 2 jours |

« Paquets à nettoyer », « Nettoyer les paquets » et « Redémarrer » n'apparaissent qu'avec un agent récent (0.1.1 et plus) : l'agent annonce au hub les actions qu'il sait faire.

Les prochains composants (Docker, sauvegardes…) s'ajouteront comme sous-composants de l'hôte, avec leurs propres alertes remontées de la même façon.

## Topics MQTT

| Topic (retenu) | Contenu |
|---|---|
| `PREFIXE/lwt` | `online` / `offline` (hub connecté ou non) |
| `PREFIXE/APPAREIL/ENTITE/state` | état de l'entité (valeur simple, ou JSON pour l'entité `update`) |
| `PREFIXE/APPAREIL/alerts/attributes` | JSON : `critical` et les 20 premières alertes |
| `PREFIXE/APPAREIL/ENTITE/set` | commande : `PRESS` (bouton), `INSTALL` (update) |

Identifiants des appareils : `homelab_manager`, `hm_ID` (hôte) et `hm_ID_apt`, où `ID` est l'identifiant interne de l'hôte : renommer un hôte ne crée pas de nouvel appareil dans Home Assistant.

Les valeurs ne sont publiées que lorsqu'elles changent ; tout est republié quand Home Assistant redémarre (`homeassistant/status`). Les tâches lancées depuis Home Assistant apparaissent dans l'activité avec la mention « Home Assistant ».
