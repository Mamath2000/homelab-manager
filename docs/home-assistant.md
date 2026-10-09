---
title: Home Assistant
description: Publier le homelab dans Home Assistant via MQTT (découverte automatique device-based)
sidebar_position: 3
---

# Home Assistant

Le hub peut publier l'état du homelab sur un broker MQTT, avec la **découverte automatique** de Home Assistant au format *device-based* : un seul message `homeassistant/device/homelab/OBJET/config` par appareil, qui décrit tous ses composants. Les mises à jour et les vérifications se déclenchent aussi depuis Home Assistant.

## Activer l'intégration

Dans l'interface : **Paramètres → Home Assistant (MQTT)**.

| Champ | Rôle |
|---|---|
| Publier le homelab dans Home Assistant | Active ou désactive l'intégration |
| Broker MQTT | `mqtt://IP:1883`, `mqtts://…`, `ws://…` ou `wss://…` |
| Utilisateur / Mot de passe | Identifiants du broker (le mot de passe n'est jamais renvoyé par l'API) |
| Préfixe des topics | Préfixe des états et commandes, `homelab-manager` par défaut |
| Préfixe de découverte | `homeassistant` par défaut |
| URL de l'interface | Lien « Visiter » des appareils dans Home Assistant (l'URL publique, par exemple) ; vide : URL du hub des paramètres Agent |

**Tester la connexion** vérifie que le broker accepte les identifiants, sans rien publier. Une fois enregistrée, la carte d'état indique si le hub est connecté et combien d'appareils sont publiés.

**Republier la découverte** (intégration connectée) renvoie toutes les configurations de découverte et tous les états, par exemple après la suppression d'un appareil dans Home Assistant ou si des entités restent à « inconnu ». Les configurations obsolètes trouvées sur le broker (appareil disparu, ancien format de topic) sont supprimées au passage ; c'est aussi fait à chaque connexion au broker.

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
| Hôtes, Hôtes hors ligne | capteurs |
| Mises à jour disponibles, Mises à jour de sécurité | capteurs (totaux de tous les hôtes) |
| Hôtes à mettre à jour, Hôtes à redémarrer, Hôtes à nettoyer | capteurs |
| Agents à mettre à jour | capteur (les agents se mettent à jour automatiquement, voir Paramètres → Agent) |
| Alertes | capteur (nombre) ; attributs `critical` et `alerts` (niveau, hôte, composant, message) |
| Problème | capteur binaire, allumé dès qu'une alerte existe |
| Tout vérifier | bouton : `apt-get update` sur les hôtes en ligne |

### Un appareil par hôte

| Entité | Type |
|---|---|
| Agent | capteur binaire de connectivité (agent connecté au hub) |
| Redémarrage requis | capteur binaire (problème), dès que l'hôte a remonté son état APT |
| Redémarrer | bouton (`systemctl reboot` sur l'hôte) |
| Agent | entité `update` (configuration) : version installée / distribuée par le hub, installable depuis HA |
| Alertes, Problème | alertes de l'agent et de tous les sous-composants de l'hôte |
| Système, Noyau, Adresse IP, Vu | diagnostic |

### Sous-composant APT

| Entité | Type |
|---|---|
| Paquets système | entité `update` : version installée / disponible, résumé des paquets, **installable depuis Home Assistant** (mise à jour complète) |
| Mises à jour, Mises à jour de sécurité | capteurs |
| Paquets à nettoyer | capteur : paquets supprimables par `apt autoremove` (liste en attribut `packages`) |
| Nettoyer les paquets | bouton : `apt-get autoremove` |
| Paquets bloqués, Dernière vérification | diagnostic |
| Alertes, Problème | diagnostic : alertes propres aux paquets |
| Rechercher les mises à jour | bouton : `apt-get update` |

Toutes les entités APT sont **indisponibles quand l'agent est hors ligne** : la disponibilité combine la LWT du hub et l'état de l'agent (`PREFIXE/hm_ID/agent/state`, `availability_mode: all`). Le résumé de l'entité `update` signale toujours les paquets qui demanderont un redémarrage.

### Alertes

| Composant | Niveau | Alerte |
|---|---|---|
| Agent | critique | Agent hors ligne |
| Agent | avertissement | Agent jamais connecté |
| Agent | avertissement | Agent à mettre à jour |
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

Topics de découverte, tous sous le *node id* `homelab` : `homeassistant/device/homelab/manager/config` (Homelab Manager), `homeassistant/device/homelab/hm_ID/config`, `homeassistant/device/homelab/hm_ID_apt/config`. Jusqu'à la 0.1.6, ils étaient publiés directement sous `homeassistant/device/<identifiant>/config` : le hub vide ces anciens topics à sa connexion et republie les appareils au nouvel emplacement.

Les valeurs ne sont publiées que lorsqu'elles changent ; tout est republié quand Home Assistant redémarre (`homeassistant/status`) ou avec « Republier la découverte ». Les états d'un appareil dont la découverte vient d'être (re)publiée sont renvoyés une seconde fois quelques secondes plus tard, le temps que Home Assistant crée ses entités. Les tâches lancées depuis Home Assistant apparaissent dans l'activité avec la mention « Home Assistant ».
