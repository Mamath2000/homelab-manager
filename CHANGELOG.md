# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/). Les versions précédentes (jusqu'à 1.0.19)
sont dans l'historique git et les tags `v*`.

## Non publié

### Ajouté

- **Rôles du hub** (Paramètres › Rôles) : ce que le hub fait au travers d'un hôte (broker MQTT, cluster Proxmox VE) se déclare
  comme un rôle porté par un hôte, avec assistant, test de connexion, réaffectation et vue inverse sur la fiche de l'hôte.
  Voir [Rôles du hub](docs/roles.md). (homelab#253, homelab#254)
- API `/api/roles` (liste, création, modification, suppression, test).

### Modifié

- Les rôles des **comptes** (`admin` / `operator` / `viewer`) deviennent des **profils** : champ `UserDoc.profile`, champ JSON
  `profile` de `/api/users` et du compte connecté, libellés de l'interface.
- Les brokers MQTT des sondes sont des rôles `mqtt-broker` (même identifiant qu'avant : les sondes continuent de les citer).
  Les routes `/api/hosts/:id/roles*` et Paramètres › Sondes disparaissent au profit de `/api/roles` et Paramètres › Rôles.
- Le pont Home Assistant publie sur un rôle `mqtt-broker` (`brokerRoleId`) ; sans rôle sélectionné, il est désactivé.
- Les clusters Proxmox VE (`settings.pve.clusters`) deviennent des rôles ; Paramètres › Sauvegardes renvoie vers Rôles.

### Migration

- Migrations automatiques au démarrage : `hosts[].roles` → `roles`, `settings.pve` → `roles`, `role` → `profile` des comptes,
  rattachement de l'ancien broker du pont Home Assistant au rôle de même adresse et de même compte (sinon « à rattacher »).
- **Pas de retour en arrière** vers une version antérieure : son ancienne migration passerait tous les comptes en `admin`.
  Sauvegarder la base MongoDB avant la mise à jour.
