---
title: Home Assistant
description: Publier le homelab dans Home Assistant via MQTT (découverte automatique device-based)
sidebar_position: 4
---

# Home Assistant

Le hub peut publier l'état du homelab sur un broker MQTT, avec la **découverte automatique** de Home Assistant au format *device-based* : un seul message `homeassistant/device/homelab/OBJET/config` par appareil, qui décrit tous ses composants. Les mises à jour et les vérifications se déclenchent aussi depuis Home Assistant.

## Relier un broker

Dans l'interface : **Paramètres → Home Assistant**. Sans broker, rien n'est publié : l'écran explique l'intégration et propose **Ajouter un broker**, qui ouvre une fenêtre en quatre étapes.

| Étape | Rôle |
|---|---|
| Broker | `mqtt://IP:1883`, `mqtts://…`, `ws://…` ou `wss://…` |
| Compte | Utilisateur / mot de passe du broker, facultatifs (broker anonyme) ; le mot de passe n'est jamais renvoyé par l'API |
| Topics | Préfixe de découverte (`homeassistant` par défaut, celui de l'intégration MQTT de Home Assistant), préfixe des états et commandes du hub (`homelab-manager` par défaut), URL de l'interface : lien « Visiter » des appareils (l'URL publique, par exemple ; vide : URL du hub des paramètres Agent) |
| Test de connexion | Vérifie que le broker accepte le compte, sans rien publier |

**Enregistrer** n'est possible qu'après un test réussi (tout changement de champ l'annule) et démarre la publication. Une fois le broker relié, le haut de l'écran résume le lien : état de la connexion, broker, compte, préfixes, nombre d'appareils publiés et dernière publication, avec **Modifier** (la même fenêtre) et **Retirer**.

**Republier la découverte** (en-tête du panneau, intégration connectée) renvoie toutes les configurations de découverte et tous les états, par exemple après la suppression d'un appareil dans Home Assistant ou si des entités restent à « inconnu ». Les configurations et états obsolètes trouvés sur le broker (appareil disparu ou déplacé, ancien format de topic) sont supprimés au passage ; c'est aussi fait à chaque connexion au broker.

:::info Retrait
Retirer le broker, ou changer de préfixe, **retire les appareils** de Home Assistant (configurations de découverte et états vidés). Le niveau de détail est conservé pour un prochain broker.
:::

:::note Stockage
Les paramètres, dont le mot de passe du broker, sont enregistrés dans la base MongoDB du hub.
:::

## Niveau de détail

Sous le lien, **Paramètres de publication** règle ce qui est créé dans Home Assistant, pour limiter le nombre d'appareils et d'entités. Un tableau montre, par catégorie, ce que publie chaque niveau ; l'aperçu en dessous donne le nombre d'entités et d'appareils qui en résulte, niveaux propres aux hôtes compris.

| Catégorie | Minimal | Standard | Complet |
|---|:-:|:-:|:-:|
| État (connectivité), alertes et problème de chaque hôte et de Homelab Manager | ✅ | ✅ | ✅ |
| Top 5 CPU / mémoire / disque | ✅ | ✅ | ✅ |
| Compteurs de Homelab Manager (hôtes, mises à jour, stacks, sauvegardes, datastores) | — | ✅ | ✅ |
| Sous-composants APT, Docker, Onduleur, Sauvegardes | — | ✅ | ✅ |
| Sondes de service : une entité par sonde | — | ✅ | ✅ |
| Sessions Windows | — | — | ✅ |
| Actions : boutons et entités `update` installables | — | — | ✅ |
| Diagnostics : système, noyau, IP, dernière vue, alertes des sous-composants | — | — | ✅ |

**Personnalisé** coche les catégories une à une (en partant du niveau courant). Les alertes ne dépendent pas du niveau : un sous-composant non publié fait toujours remonter ses alertes sur son hôte et sur Homelab Manager.

**Par hôte**, le niveau global peut être remplacé : onglet **Home Assistant** des options de l'hôte, ou **Niveau Home Assistant** sur une sélection dans la liste des hôtes. Les deux présentent le même tableau, limité aux catégories d'un hôte (APT, Docker, Onduleur, Sauvegardes, Sondes, Sessions Windows, Actions, Diagnostics), avec l'aperçu de ses entités : *Niveau global* (par défaut), *Aucun* (hôte non publié), *Minimal*, *Standard*, *Complet* ou *Personnalisé*. Compteurs et top 5, publiés sur Homelab Manager, ne suivent que le niveau global. Un hôte réglé sur *Aucun* n'a ni appareil, ni alertes, ni place dans les compteurs et les top 5 ; tous les autres comptent dans les totaux de Homelab Manager, quel que soit leur niveau. Les hôtes du [réseau d'accès Tailscale](installation.md#réseau-daccès-lan-ou-tailscale) sont créés au niveau *Aucun*. L'ancienne case « exclu de Home Assistant » est lue comme *Aucun*.

Changer de niveau retire de Home Assistant les appareils et entités qui ne sont plus publiés.

:::warning Mise à jour
Le niveau global par défaut est **Minimal**, y compris pour une installation existante sans réglage enregistré : à la mise à jour, les sous-composants, compteurs, actions et diagnostics disparaissent de Home Assistant jusqu'à ce qu'un niveau plus riche soit choisi.
:::

## Appareils créés

Les appareils sont organisés en hiérarchie (`via_device`) : les **alertes remontent** de chaque composant vers son hôte, puis vers Homelab Manager ; le **détail** reste dans les sous-composants.

```text
Homelab Manager
├── pve1                      (un appareil par hôte)
│   ├── pve1 · APT            (sous-composant : paquets système)
│   └── pve1 · Onduleur       (sous-composant : onduleur NUT)
├── docker-01
│   ├── docker-01 · APT
│   ├── docker-01 · media     (sous-composant : une stack docker compose)
│   └── docker-01 · traefik
└── …
```

### Homelab Manager

| Entité | Type |
|---|---|
| Hôtes, Hôtes hors ligne | capteurs (les hôtes itinérants ne comptent pas comme hors ligne) |
| Mises à jour disponibles, Mises à jour de sécurité | capteurs (totaux de tous les hôtes) |
| Hôtes à mettre à jour, Hôtes à redémarrer, Hôtes à nettoyer | capteurs |
| Agents à mettre à jour | capteur (les agents se mettent à jour automatiquement, voir Paramètres → Agent) |
| Alertes | capteur (nombre) ; attributs `critical` et `alerts` (niveau, hôte, composant, message) |
| Problème | capteur binaire, allumé dès qu'une alerte existe |
| Tout vérifier | bouton : `apt-get update` sur les hôtes en ligne |
| Stacks Docker, Stacks à mettre à jour | capteurs, présents dès qu'un hôte a Docker |
| Top CPU, Top mémoire, Top disque | capteurs : nom de l'hôte le plus chargé ; attributs `top1_name` … `top5_name` et `top1_cpu` / `top1_mem` / `top1_disk` (%) ; pour le disque, le pire volume de chaque hôte et `topN_volume` |

Les top 5 classent les hôtes en ligne, hors hôtes itinérants (leurs dernières valeurs seraient périmées) et hors niveau *Aucun*.

### Un appareil par hôte

| Entité | Type |
|---|---|
| État | capteur binaire de connectivité (agent connecté au hub : en ligne / hors ligne) ; `unique_id` `hm_ID_etat`, entité `binary_sensor.HOTE_etat` à la création |
| Redémarrage requis | capteur binaire (problème), dès que l'hôte a remonté son état APT |
| Redémarrer | bouton (`systemctl reboot` sur l'hôte) |
| Agent | entité `update` (configuration) : version installée / distribuée par le hub, installable depuis HA ; indisponible quand l’agent est hors ligne |
| Vérifier les images Docker | bouton (hôtes avec Docker) : compare les images des stacks à leur registre |
| Alertes, Problème | alertes de l'agent et de tous les sous-composants de l'hôte |
| Système, Noyau, Adresse IP, Vu | diagnostic |

### Postes Windows

Un [poste Windows](installation.md#postes-windows) a en plus, sur son appareil, les entités de ses sessions. Elles sont **indisponibles quand l'agent est hors ligne** (poste éteint).

| Entité | Type |
|---|---|
| Utilisateur connecté | capteur binaire (`occupancy`) : au moins une session ouverte |
| Session verrouillée | capteur binaire : toutes les sessions ouvertes sont verrouillées |
| Utilisateurs | capteur : nombre d'utilisateurs connectés ; attributs `users` (noms) et `sessions` (détail : poste, état, ouverture) |

Ni APT, ni Docker, ni bouton Redémarrer, ni entité de mise à jour de l'agent.

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

Toutes les entités APT sont **indisponibles quand l'agent est hors ligne** : la disponibilité combine la LWT du hub et l'état de l'agent (`PREFIXE/HOTE/etat/state`, `availability_mode: all`). Le résumé de l'entité `update` signale toujours les paquets qui demanderont un redémarrage.

### Sous-composant Docker (un par stack)

| Entité | Type |
|---|---|
| État | capteur : En marche, Partielle, Arrêtée, Down ; services, images et conteneurs en attribut |
| Conteneurs | capteur : conteneurs en marche / total (`2/3`) |
| Images | entité `update` : « N mise(s) à jour » quand une image plus récente est publiée ou téléchargée sans être redéployée, **installable depuis Home Assistant** (`docker compose pull` + `up -d`) |
| Démarrer, Arrêter, Redémarrer | boutons (`docker compose up -d`, `stop`, `restart`) |
| Alertes, Problème | diagnostic : alertes propres à la stack |

Comme APT, une stack est indisponible quand l'agent est hors ligne. Voir [Docker](docker.md). Une stack non managée n'est pas publiée (son appareil est retiré).

### Sous-composant Onduleur

Un par hôte dont l'agent remonte un onduleur NUT. Détail et seuils : [Onduleur](onduleur.md).

| Entité | Type |
|---|---|
| État | capteur : drapeaux `ups.status` (`OL`, `OB`, `RB`…) |
| Charge batterie, Autonomie, Charge | capteurs (%, s, %) |
| Tension d'entrée | capteur (V) |
| Sur batterie | capteur binaire |
| Batterie à remplacer | capteur binaire (problème) |
| Tension batterie, Alertes, Problème | diagnostic |

Indisponible quand l'agent est hors ligne, comme APT et Docker.

### Sondes de service

Une entité par [sonde](sondes.md) de l'hôte, **sur l'appareil de l'hôte** ou, pour une sonde rattachée à une stack Docker, **sur l'appareil de cette stack** (sur celui de l'hôte si l'appareil de la stack n'est pas publié). Catégorie **Sondes**, présente aux niveaux Standard et Complet.

| Entité | Type |
|---|---|
| Nom de la sonde | capteur binaire de connectivité : allumé quand le service répond ; attributs `type`, `target` (cible), `since` (dernier changement) et `message` (raison d'un échec) |

Une sonde **inconnue** (broker MQTT injoignable, ping non autorisé, hôte itinérant absent, pas encore mesurée) est **indisponible** dans Home Assistant, et non éteinte : le service n'est pas jugé. À l'inverse de APT et Docker, ces entités **restent disponibles quand l'agent est hors ligne** : c'est le hub qui mesure, pas l'hôte. Le niveau de l'hôte et sa catégorie Sondes ne changent pas les alertes : une sonde hors service fait toujours remonter une alerte sur le problème de l'hôte.

### Alertes

| Composant | Niveau | Alerte |
|---|---|---|
| Agent | critique | Agent hors ligne (sauf hôte itinérant) |
| Agent | avertissement | Agent jamais connecté |
| Agent | avertissement | Agent à mettre à jour |
| APT | avertissement | Mises à jour de sécurité disponibles |
| APT | avertissement | Redémarrage requis |
| APT | avertissement | Listes de paquets non rafraîchies depuis plus de 2 jours (sauf hôte itinérant hors ligne) |
| Docker | avertissement | Stack partielle (une partie des conteneurs seulement tourne) |
| Docker | avertissement | Conteneur en mauvaise santé (`unhealthy`) |
| Docker | avertissement | Conteneur qui redémarre en boucle |
| Onduleur | critique | Batterie à remplacer, alarme, sur batterie, batterie faible, surcharge, arrêt forcé |
| Onduleur | avertissement | Charge ou autonomie sous le seuil NUT, auto-test en échec, statut inhabituel |
| Services | critique | Sonde hors service (les sondes inconnues ne comptent pas) |

« Paquets à nettoyer », « Nettoyer les paquets » et « Redémarrer » n'apparaissent qu'avec un agent récent (0.1.1 et plus) : l'agent annonce au hub les actions qu'il sait faire.

Une stack arrêtée volontairement ne déclenche pas d'alerte. Les prochains composants (sauvegardes…) s'ajouteront comme sous-composants de l'hôte, avec leurs propres alertes remontées de la même façon.

## Topics MQTT

| Topic (retenu) | Contenu |
|---|---|
| `PREFIXE/lwt` | `online` / `offline` (hub connecté ou non) |
| `PREFIXE/APPAREIL/ENTITE/state` | état de l'entité (valeur simple, ou JSON pour l'entité `update`) |
| `PREFIXE/APPAREIL/alerts/attributes` | JSON : `critical` et les 20 premières alertes |
| `PREFIXE/APPAREIL/ENTITE/set` | commande : `PRESS` (bouton), `INSTALL` (update) |

`APPAREIL` est le **nom de l'hôte** en minuscules, sans accents, les autres caractères remplacés par `_` : `pve1`, `pve1_apt`, `pve1_ups`, `pve1_backup`, `pve1_docker_STACK`, et `manager` pour Homelab Manager. Si deux hôtes donnent le même nom, le plus ancien le garde et l'autre reçoit en plus la fin de son identifiant (`pve1_0abc02`).

Topics de découverte, tous sous le *node id* `homelab` : `homeassistant/device/homelab/manager/config` (Homelab Manager), `homeassistant/device/homelab/pve1/config`, `homeassistant/device/homelab/pve1_apt/config`…

Les identifiants des appareils et des entités (`unique_id`) restent fondés sur l'identifiant interne de l'hôte (`hm_ID`, `hm_ID_apt`…). En revanche, un topic de découverte qui change (**hôte renommé**, ou passage des topics `hm_ID` aux noms) oblige le hub à vider l'ancienne configuration avant de publier la nouvelle : Home Assistant supprime puis recrée l'appareil, qui perd sa pièce et les personnalisations de ses entités. Jusqu'à la 0.1.6, les configurations étaient publiées directement sous `homeassistant/device/<identifiant>/config` ; ces anciens topics sont traités de la même façon.

Les valeurs ne sont publiées que lorsqu'elles changent ; tout est republié quand Home Assistant redémarre (`homeassistant/status`) ou avec « Republier la découverte ». Les états d'un appareil dont la découverte vient d'être (re)publiée sont renvoyés une seconde fois quelques secondes plus tard, le temps que Home Assistant crée ses entités. Les tâches lancées depuis Home Assistant apparaissent dans l'activité avec la mention « Home Assistant ».
