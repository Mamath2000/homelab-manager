---
title: Onduleur
description: Suivi de l'onduleur d'un hôte via NUT (état, batterie, autonomie, charge, tensions), indicateur de fin de vie de la batterie et alertes dans l'interface et Home Assistant
sidebar_position: 3.8
---

# Onduleur

Homelab Manager suit l'**onduleur (UPS) branché sur un hôte**, tel que le publie [NUT](https://networkupstools.org/) (Network UPS Tools). L'agent de l'hôte interroge `upsd` en local ; rien n'est exposé sur le réseau. **Un seul onduleur par hôte** : le premier listé par `upsc -l`.

## Prérequis

- NUT installé et configuré sur l'hôte, avec `upsd` qui répond en local : `upsc -l` liste l'onduleur et `upsc NOM` renvoie ses valeurs.
- Un agent Homelab Manager récent sur l'hôte. L'agent annonce la capacité `ups` au hub dès que `upsc` trouve un onduleur ; sans NUT ou sans onduleur, l'hôte n'a ni panneau ni alerte d'onduleur.

L'agent relève l'onduleur toutes les minutes et ne transmet au hub que ce qui change, avec un envoi au moins toutes les 5 minutes.

## Panneau de la fiche hôte

Le panneau **Onduleur** est le premier bloc de la colonne de gauche de la fiche, au-dessus des paquets APT.

| Élément | Origine NUT | Remarque |
|---|---|---|
| Modèle, nom NUT, driver | `ups.model`, nom de l'onduleur, `driver.name` | |
| Sur secteur / Sur batterie | `ups.status` (`OL`, `OB`) | |
| Batterie OK / à remplacer / faible | `ups.status` (`RB`, `LB`) | un encart explique la fin de vie quand `RB` est actif |
| Charge batterie | `battery.charge` | repère sur la jauge : `battery.charge.warning` |
| Autonomie restante | `battery.runtime` | repère sur la jauge : `battery.runtime.low` ; la jauge est graduée sur 30 minutes |
| Charge de l'onduleur | `ups.load` | jauge en avertissement à partir de 80 % |
| Tension d'entrée, tension batterie | `input.voltage`, `battery.voltage` | avec la valeur nominale |
| Dernier auto-test, alarme sonore | `ups.test.result`, `ups.beeper.status` | |

Une valeur que l'onduleur ne remonte pas est affichée « — ».

:::note Âge de la batterie
La date de fabrication de la batterie (`battery.mfr.date`) est affichée à titre indicatif. L'âge n'entre pas dans les alertes : `battery.date` garde la valeur d'usine sur beaucoup d'onduleurs, et la fin de vie repose sur le drapeau `RB`, l'autonomie et les auto-tests.
:::

## Alertes

L'onduleur est un domaine d'alerte à part entière : il apparaît dans la frise des 30 jours de la fiche (ligne **Onduleur**, seulement pour les hôtes qui en ont un) et compte dans la frise par site du tableau de bord (filtre « Tout »). Comme APT et Docker, il n'est suivi que tant que l'agent est connecté.

| Niveau | Condition |
|---|---|
| Alerte | Batterie à remplacer (`RB`) |
| Alerte | Onduleur en alarme (`ALARM`), arrêt forcé en cours (`FSD`), surcharge (`OVER`) |
| Alerte | Sur batterie : coupure secteur (`OB`) |
| Alerte | Batterie faible (`LB`) |
| Avertissement | Charge batterie sous `battery.charge.warning` (hors fonctionnement sur batterie) |
| Avertissement | Autonomie sous ou égale à `battery.runtime.low` |
| Avertissement | Dernier auto-test en échec (résultat contenant `error`, `fail` ou `warning`) |
| Avertissement | Statut inhabituel (ni `OL` ni `OB`) |

Les seuils viennent de NUT : ils se règlent sur l'onduleur ou dans la configuration du driver, pas dans Homelab Manager.

## Home Assistant

Avec l'[intégration Home Assistant](home-assistant.md), chaque hôte qui a un onduleur reçoit un sous-composant **« hôte · Onduleur »** (identifiant `hm_ID_ups`). Ses alertes remontent à l'appareil de l'hôte puis à Homelab Manager.

| Entité | Type |
|---|---|
| État | capteur : drapeaux `ups.status` bruts |
| Charge batterie | capteur `battery` (%) |
| Autonomie | capteur `duration` (s) |
| Charge | capteur (%) |
| Tension d'entrée | capteur `voltage` (V) |
| Sur batterie | capteur binaire |
| Batterie à remplacer | capteur binaire (problème) |
| Tension batterie | diagnostic |
| Alertes, Problème | diagnostic |

Comme APT et Docker, ces entités sont indisponibles quand l'agent est hors ligne.
