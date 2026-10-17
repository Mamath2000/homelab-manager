---
title: Onduleur
description: Suivi de l'onduleur d'un hôte via NUT (état, batterie, autonomie, charge, tensions), indicateur de fin de vie de la batterie, alertes, et actions (bip, test batterie) dans l'interface et Home Assistant
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

## Actions : bip et test batterie

Le panneau propose trois actions, **désactivées tant que l'hôte n'est pas configuré** (l'onduleur reste alors en lecture seule) :

| Bouton | Commande NUT | Effet |
|---|---|---|
| Couper le bip | `beeper.mute` | coupe l'alarme sonore en cours, temporairement |
| Activer / Désactiver l'alarme | `beeper.enable` / `beeper.disable` | l'une ou l'autre selon l'état de `ups.beeper.status` |
| Test batterie rapide | `test.battery.start.quick` | l'onduleur bascule brièvement sur batterie ; le résultat apparaît dans « Dernier auto-test ». Une confirmation est demandée |

Ces quatre commandes sont les seules possibles : la liste est fixée dans le hub et dans l'agent, qui n'exécute jamais une commande libre. Un test peut faire décrocher un onduleur dont la batterie est morte ; l'interface le rappelle quand `RB` ou `LB` est actif.

### Configuration d'un hôte

L'agent agit sur l'onduleur avec un **utilisateur NUT dédié**, `hm-agent`, qui n'a le droit que de ces quatre commandes (pas de `SET`, pas de coupure de charge). Son mot de passe est lu dans un fichier de l'hôte ; le hub ne le voit jamais. Une fois par hôte, en root :

1. Ajouter l'utilisateur à `upsd.users` (généralement `/etc/nut/upsd.users`), avec un mot de passe aléatoire :

   ```ini
   [hm-agent]
     password = MOT_DE_PASSE
     instcmds = beeper.enable beeper.disable beeper.mute test.battery.start.quick
   ```

2. Recharger `upsd` : `systemctl reload nut-server` (ou `upsd -c reload`).
3. Écrire le même mot de passe, seul sur sa ligne, dans le répertoire de l'agent :

   ```bash
   install -d -m 0700 /etc/homelab-agent
   install -m 0600 /dev/null /etc/homelab-agent/ups.pass
   echo 'MOT_DE_PASSE' > /etc/homelab-agent/ups.pass
   ```

4. Vérifier : `echo 'MOT_DE_PASSE' | upscmd -u hm-agent NOM_UPS beeper.mute` doit répondre `OK`.

**Unraid (plugin NUT)** : le répertoire de l'agent est `/boot/homelab-man` (`/etc` est en RAM), donc le fichier est `/boot/homelab-man/ups.pass`. L'utilisateur se déclare à deux endroits, avec la même section : `/etc/nut/upsd.users` et sa copie persistante `/boot/config/plugins/nut-dw/ups/upsd.users`, que le plugin recopie dans `/etc/nut` au démarrage. Le réglage « Enable Manual Configuration » du plugin doit être sur « for UPS Driver » (`onlyups`) ou « Yes » ; sur « No », l'interface réécrit `upsd.users` et supprime la section.

L'agent détecte le fichier à sa reconnexion au hub ou au plus tard au bout de 30 minutes (redémarrer `homelab-agent` pour que ce soit immédiat) et annonce la capacité `ups_control`. Pour retirer l'accès, supprimer `ups.pass` (et l'utilisateur dans `upsd.users`).

:::note Sécurité
Le fichier est en clair, comme tout mot de passe de `upsd.users` : NUT n'en connaît pas d'autre forme. Il n'est lisible que par root, comme le reste du répertoire de l'agent. Le compte `hm-agent` ne peut ni couper la charge ni modifier un réglage ; au pire, une fuite permet de faire sonner ou taire le bip, ou de lancer un test. Si `upsd` écoute sur le réseau (`LISTEN` dans `upsd.conf`), limite l'accès au port 3493 au réseau des serveurs.
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
