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

- **Tableau de bord par site** : une colonne par hôte, regroupée par site, avec un carré par domaine suivi (connexion, mises à jour, Docker, sauvegardes, copie externe, onduleur : voir [Alertes et statuts](alertes.md)) ; chiffres clés (correctifs de sécurité, sauvegardes en échec ou en retard), jauges par site, hôtes des sites principal et VPN regroupés par type (PVE, PBS, VM, LXC, Physique, Windows, WSL), arrivée des alertes sur 30 jours (une ligne par site, pire situation de ses hôtes), actions sur tous les hôtes concernés (correctifs de sécurité seuls, tout APT, images Docker, agents, standardisation, avec confirmation listant les cibles) et listes « à traiter ». Les sites se décrivent dans **Paramètres › Sites et tags** (nom, type Principal / VPN / Externe, ordre d'affichage ; les sites externes d'un seul hôte sont réunis dans une carte) et chaque hôte choisit le sien dans sa fiche.
- **Tags** : plusieurs par hôte, avec une couleur choisie à leur création (depuis la fiche de l'hôte) ; renommés, recolorés ou supprimés dans **Paramètres › Sites et tags**. Filtres par site et par tag sur la page Hôtes. Les groupes des versions précédentes sont devenus des tags.
- **Affichage mobile** (homelab#192 à #204) : sous le point de rupture `md`, les tableaux (Docker, Sauvegardes, Mises à jour, Activité, Comptes) passent en cartes, le détail d'une sauvegarde s'ouvre en fenêtre, la recherche d'hôte est dans l'en-tête, les cibles tactiles font au moins 44 px et les champs 16 px (pas de zoom automatique sur iOS) ; les fenêtres et la frise d'alertes tiennent dans la largeur de l'écran.
- **Inventaire** : OS, noyau, architecture, virtualisation (LXC, KVM…), IP, uptime, état de connexion en temps réel.
- **Mises à jour APT** : paquets à mettre à jour, mises à jour de sécurité, paquets bloqués (`hold`), redémarrage requis, ancienneté des listes de paquets.
- **Actions** : `apt-get update`, mise à jour complète ou de paquets choisis, sur un hôte ou plusieurs à la fois, avec les logs en direct.
- **Vue par paquet** : voir sur quels hôtes un paquet est en retard et le mettre à jour partout en un clic.
- **Vérification planifiée** : `apt-get update` automatique toutes les 12 h.
- **Nettoyage** : paquets inutiles (anciens noyaux, dépendances orphelines) supprimables via `apt autoremove`.
- **Historique** des tâches et de leurs sorties (90 jours).
- **Fiche hôte** : bandeau système et frise des alertes des 30 derniers jours (une ligne par domaine que l'hôte fournit : pire situation de chaque jour, détail au clic) en tête de page ; sur grand écran, l'historique et la console en direct restent visibles à droite, et toute tâche lancée depuis la fiche s'y affiche. **Actualiser** demande aussi à l'agent de relire son état local (système, APT, stacks Docker, sauvegardes Home Assistant, onduleur) ; l'agent annonce la capacité `refresh` (requête `refresh` avec des portées facultatives).
- **Docker** : stacks compose des hôtes, état des conteneurs, images à mettre à jour, démarrer / arrêter / redémarrer / mettre à jour, logs et fichiers compose.
- **Onduleur** : état, batterie, autonomie, charge et tensions de l'onduleur d'un hôte (via NUT), indicateur de batterie à remplacer et alertes.
- **Sondes de service** : vérifier depuis le hub qu'un service répond (MQTT, ping, TCP, HTTP), par hôte ou par stack, avec un domaine **Services** dans les alertes et des entités dans Home Assistant.
- **Clés d'API** : comptes sans mot de passe et clés nommées (une par service) pour interroger le hub, par exemple depuis Homepage.
- **Home Assistant** (option) : appareils, alertes et mises à jour publiés via MQTT, avec découverte automatique.

## Principes

- **Réseau local uniquement** : rien n'est exposé sur Internet, aucun port à ouvrir sur les hôtes (l'agent se connecte au hub, pas l'inverse).
- **Déploiement simple** : un `docker compose` pour le hub, une commande à copier pour chaque agent.
- **Pas de commande arbitraire** : l'agent n'exécute qu'une liste fixe d'actions.
- **Échanges protégés** : connexion des agents en TLS avec un certificat par agent, commande d'installation à usage unique, agents signés (voir [Sécurité](securite.md)).

## Pages

- [Installation](installation.md) : hub et agents.
- [Configuration](configuration.md) : variables d'environnement, reverse proxy, données.
- [Docker](docker.md) : stacks compose, mises à jour des images, actions, logs.
- [Onduleur](onduleur.md) : suivi d'un onduleur via NUT, fin de vie de la batterie, alertes.
- [Sondes de service](sondes.md) : MQTT, ping, TCP et HTTP depuis le hub, brokers MQTT, états et alertes.
- [Alertes et statuts](alertes.md) : domaines, éléments suivis, agrégation hôte → site, hôte hors ligne ou itinérant.
- [Home Assistant](home-assistant.md) : intégration MQTT avec découverte automatique.
- [Comptes et rôles](comptes.md) : premier démarrage, rôles, mots de passe, comptes sans mot de passe, clés d'API.
- [API](api.md) : accès par clé d'API et endpoint `/api/summary` pour les tableaux de bord.
- [Sécurité](securite.md) : connexion des agents, enrôlement, révocation, signature des binaires.
