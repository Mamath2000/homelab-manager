# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/). L'historique complet est dans git et les tags `v*`.

## Non publié

Tout ce qui suit la dernière version **promue en prod** (`latest` = 1.0.1). Les versions 1.0.2 à 1.0.19 n'existent que sur
le canal `dev`.

### Ajouté

- **Sondes de service** : MQTT, ping, TCP et HTTP mesurées par le hub, domaine « Services » dans le monitoring, panneau
  sur la fiche d'un hôte ou d'un équipement, publication dans Home Assistant. Voir [Sondes de service](docs/sondes.md). (homelab#236)
- **Proxmox VE** : inventaire d'un cluster (nœuds, VM et CT, liens avec les hôtes par adresse MAC, jobs de sauvegarde,
  sauvegardes vzdump hors PBS), voir [Proxmox VE](docs/proxmox-ve.md).
- **Installation de l'agent depuis l'inventaire Proxmox VE** : dans les CT (`pct exec`) et sur les autres nœuds du cluster
  (SSH), aperçu avant lancement, vérification préalable en lecture seule, réinstallation après révocation. Le code d'enrôlement
  passe sur l'entrée standard (`-code-stdin`, `HLM_ENROLL_CODE`). (homelab#259)
- **Rôles du hub** (Paramètres › Rôles) : broker MQTT, cluster Proxmox VE, PBS principal, PBS hors site et contrôleur Omada se
  déclarent comme des rôles portés par un hôte, avec assistant, test de connexion, réaffectation et vue inverse sur la fiche de
  l'hôte. API `/api/roles`. Voir [Rôles du hub](docs/roles.md). (homelab#252, #253, #254)
- Équipements et tableau de bord, graphiques, menu de gauche et volet flottant revus ; corrections d'affichage mobile et tablette
  (homelab#239 à #249).

### Modifié

- Les rôles des **comptes** (`admin` / `operator` / `viewer`) deviennent des **profils** : champ `UserDoc.profile`, champ JSON
  `profile` de `/api/users` et du compte connecté, libellés de l'interface.
- Le pont Home Assistant publie sur un rôle `mqtt-broker` (`brokerRoleId`) ; sans rôle sélectionné, il est désactivé.
- Les clusters Proxmox VE se déclarent comme rôles ; Paramètres › Sauvegardes renvoie vers Rôles.

### Migration

- Migrations automatiques au démarrage : `role` → `profile` des comptes, rattachement de l'ancien broker du pont Home Assistant
  au rôle de même adresse et de même compte (sinon « à rattacher »).
- **Pas de retour en arrière** vers une version antérieure : son ancienne migration passerait tous les comptes en `admin`.
  Sauvegarder la base MongoDB avant la mise à jour.
