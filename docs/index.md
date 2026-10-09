---
id: index
title: Homelab Manager
description: Administration du homelab — état des hôtes et mises à jour système (APT) depuis une seule interface
sidebar_position: 0
---

# Homelab Manager

Interface unique pour administrer les serveurs, VM et LXC du homelab. Un **hub** (conteneur Docker) centralise l'état des hôtes ; un **agent** léger installé sur chaque hôte le tient à jour et exécute les actions demandées depuis l'interface.

![Tableau de bord](./img/dashboard.png)

## Ce que fait la version actuelle

- **Inventaire** : OS, noyau, architecture, virtualisation (LXC, KVM…), IP, uptime, état de connexion en temps réel.
- **Mises à jour APT** : paquets à mettre à jour, mises à jour de sécurité, paquets bloqués (`hold`), redémarrage requis, ancienneté des listes de paquets.
- **Actions** : `apt-get update`, mise à jour complète ou de paquets choisis, sur un hôte ou plusieurs à la fois, avec les logs en direct.
- **Vue par paquet** : voir sur quels hôtes un paquet est en retard et le mettre à jour partout en un clic.
- **Vérification planifiée** : `apt-get update` automatique toutes les 12 h.
- **Nettoyage** : paquets inutiles (anciens noyaux, dépendances orphelines) supprimables via `apt autoremove`.
- **Historique** des tâches et de leurs sorties (90 jours).
- **Home Assistant** (option) : appareils, alertes et mises à jour publiés via MQTT, avec découverte automatique.

## Principes

- **Réseau local uniquement** : rien n'est exposé sur Internet, aucun port à ouvrir sur les hôtes (l'agent se connecte au hub, pas l'inverse).
- **Déploiement simple** : un `docker compose` pour le hub, une commande à copier pour chaque agent.
- **Pas de commande arbitraire** : l'agent n'exécute qu'une liste fixe d'actions.

## Pages

- [Installation](installation.md) : hub et agents.
- [Configuration](configuration.md) : variables d'environnement, reverse proxy, données.
- [Home Assistant](home-assistant.md) : intégration MQTT avec découverte automatique.
