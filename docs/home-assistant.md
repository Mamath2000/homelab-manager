---
title: Home Assistant
description: Publier le homelab dans Home Assistant via MQTT (découverte automatique device-based)
sidebar_position: 4
---

# Home Assistant

Le hub peut publier l'état du homelab — en entier, ou un site — sur le broker MQTT d'un ou plusieurs Home Assistant, avec la **découverte automatique** au format *device-based* : un seul message `homeassistant/device/homelab/OBJET/config` par appareil, qui décrit tous ses composants. Les mises à jour et les vérifications se déclenchent aussi depuis Home Assistant.

## Rôles Home Assistant

Chaque Home Assistant alimenté par le hub est un [rôle](roles.md) **Home Assistant** (`home-assistant`), **porté par le hub** et déclaré dans **Paramètres › Rôles › Déclarer un rôle** dès qu'un rôle `Broker MQTT` existe. Le rôle ne passe **que par l'intégration MQTT** de Home Assistant : ni API, ni jeton ; le hub publie sur le broker auquel ce Home Assistant est relié, avec l'adresse et le compte du rôle broker.

- **Un broker par rôle**, et un broker ne sert qu'à **un seul** rôle Home Assistant : deux Home Assistant reliés à deux brokers différents reçoivent chacun leurs appareils, sans se marcher dessus.
- **Deux modes** :
  - **Tout le homelab** (`full`) : tous les hôtes et équipements, quel que soit leur site ; la publication peut les **regrouper par site** (voir plus bas) ;
  - **Un site** (`site`) : seulement les hôtes et équipements de ce site. Les compteurs, alertes et top 5 de l'appareil racine ne portent que sur eux, les datastores du PBS (communs au homelab) n'y sont pas, et l'appareil racine s'appelle **Homelab Manager — &lt;site&gt;**. Les **commandes** reçues ne visent que les hôtes du site.

Exemple : un rôle « Home Assistant » (tout le homelab) sur le broker de vouille, et un rôle « Home Assistant — Jarsay » (site jarsay) sur le broker de jarsay.

L'assistant de déclaration (le même pour modifier, crayon de la carte du rôle) a cinq étapes :

| Étape | Rôle |
|---|---|
| Nom | nom du rôle ; vide : « Home Assistant » ou « Home Assistant — &lt;site&gt; » |
| Broker | le rôle `Broker MQTT` auquel ce Home Assistant est relié (un broker déjà utilisé par un autre rôle Home Assistant est grisé) |
| Périmètre | **Tout le homelab**, ou un site |
| Topics | préfixe de découverte (`homeassistant` par défaut, celui de l'intégration MQTT), préfixe des états et commandes du hub (`homelab-manager` par défaut), URL de l'interface facultative (lien « Visiter » des appareils ; vide : URL du hub des paramètres Agent) |
| Test | vérifie que le broker accepte le compte du rôle broker, sans rien publier |

**Enregistrer** demande un test réussi (une modification qui garde son broker n'est pas retestée) et démarre la publication. Le bouton **Publication** de la carte ouvre l'écran du rôle (`/roles/homeassistant?role=<id>`) : en haut, l'état de la connexion, le broker, le compte, le périmètre, les préfixes, le nombre d'appareils publiés et la dernière publication, avec **Modifier** (l'assistant) et **Supprimer** ; en dessous, le niveau de détail.

**Republier la découverte** (en-tête de l'écran, rôle connecté) renvoie toutes les configurations de découverte et tous les états, par exemple après la suppression d'un appareil dans Home Assistant ou si des entités restent à « inconnu ». Les configurations et états obsolètes trouvés sur le broker (appareil disparu ou déplacé, ancien format de topic) sont supprimés au passage ; c'est aussi fait à chaque connexion au broker.

:::info Retrait
Supprimer le rôle, le passer sur un autre rôle broker ou changer de préfixe **retire les appareils** du Home Assistant concerné (configurations de découverte et états vidés), puis les publie au nouvel endroit. Un changement d'adresse du même rôle broker (son hôte a changé d'IP) ne retire rien. Changer de périmètre retire de Home Assistant ce qui n'est plus publié.
:::

:::note Migration
À la mise à jour (homelab#361), le pont unique d'avant (Paramètres › Home Assistant) devient un rôle **Home Assistant**, mode tout le homelab, sur le même broker, avec **les mêmes préfixes**, le même niveau de détail et le même regroupement : les appareils restent tels quels dans Home Assistant. Un pont encore sur un broker saisi avant les rôles est rattaché au rôle broker de même adresse et de même compte ; s'il n'y en a pas, il n'est pas migré (journal du hub) tant qu'un tel rôle n'est pas déclaré. Les niveaux propres aux hôtes et la case « exclu de Home Assistant » disparaissent : tous les hôtes du périmètre d'un rôle sont publiés.
:::

## Niveau de détail

Dans l'écran d'un rôle, **Paramètres de publication** règle ce qui est créé dans son Home Assistant, pour limiter le nombre d'appareils et d'entités : un niveau par rôle, pour tout ce qu'il publie. Un tableau montre, par catégorie, ce que publie chaque niveau ; l'aperçu en dessous donne le nombre d'entités et d'appareils qui en résulte.

| Catégorie | Minimal | Standard | Complet |
|---|:-:|:-:|:-:|
| État (connectivité), alertes et problème de chaque hôte et de Homelab Manager | ✅ | ✅ | ✅ |
| Top 5 CPU / mémoire / disque | ✅ | ✅ | ✅ |
| Compteurs de Homelab Manager (hôtes, mises à jour, stacks, sauvegardes, datastores) | — | ✅ | ✅ |
| Sous-composants APT, Docker, Onduleur, Sauvegardes | — | ✅ | ✅ |
| Sondes de service : une entité par sonde | — | ✅ | ✅ |
| Équipements : un appareil par [équipement](equipements.md), comptés par Homelab Manager | — | ✅ | ✅ |
| Sessions Windows | — | — | ✅ |
| Actions : mises à jour lancées depuis Home Assistant (voir [Sécurité des commandes](#sécurité-des-commandes)) | — | — | ✅ |
| Diagnostics : système, noyau, IP, dernière vue, alertes des sous-composants | — | — | ✅ |

**Personnalisé** coche les catégories une à une (en partant du niveau courant). Les alertes ne dépendent pas du niveau : un sous-composant non publié fait toujours remonter ses alertes sur son hôte et sur Homelab Manager.

Changer de niveau retire de Home Assistant les appareils et entités qui ne sont plus publiés.

:::warning Mise à jour
Le niveau par défaut est **Minimal**, y compris pour une installation existante sans réglage enregistré : à la mise à jour, les sous-composants, compteurs, actions et diagnostics disparaissent de Home Assistant jusqu'à ce qu'un niveau plus riche soit choisi.
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

Pour un rôle **tout le homelab**, la case **Regrouper les entités par site** (Paramètres de publication, désactivée par défaut ; absente pour un rôle de site) intercale un appareil par site entre Homelab Manager et ses hôtes et équipements :

```text
Homelab Manager
├── Vouillé                   (appareil de site : alertes et problème remontés)
│   ├── pve1
│   └── Switch salon          (équipement)
└── nas-sans-site             (hôte ou équipement sans site : sous Homelab Manager)
```

Un site sans hôte ni équipement publié n'a pas d'appareil. Les appareils gardent leurs identifiants : activer ou désactiver la case ne fait que changer leur appareil parent.

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
| Agent | entité `update` (configuration) : version installée / distribuée par le hub, installable depuis HA ; indisponible quand l’agent est hors ligne |
| Home Assistant OS, Home Assistant Core | entités `update` en lecture seule (hôtes HAOS, section APT) : version installée / disponible, sans installation depuis cette entité |
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

Ni APT, ni Docker, ni entité de mise à jour de l'agent.

### Sous-composant APT

| Entité | Type |
|---|---|
| Paquets système | entité `update` : version installée / disponible, résumé des paquets, **installable depuis Home Assistant** (mise à jour complète) |
| Mises à jour, Mises à jour de sécurité | capteurs |
| Paquets à nettoyer | capteur : paquets supprimables par `apt autoremove` (liste en attribut `packages`) |
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

### Appareils de site

Avec *Regrouper les entités par site* : **Alertes** (nombre ; attributs `critical` et `alerts`) et **Problème**, agrégés sur les hôtes et équipements du site.

### Équipements

Un appareil par [équipement](equipements.md), catégorie **Équipements** (niveaux Standard et Complet, niveau global seulement).

| Entité | Type |
|---|---|
| Nom de la sonde | capteur binaire de connectivité, même format que les [sondes de service](#sondes-de-service) des hôtes |
| Alertes, Problème | capteur (nombre, attributs `critical` et `alerts`) et capteur binaire, allumé dès qu'une alerte existe |
| Adresse IP | diagnostic |

Sur Homelab Manager : **Équipements** (nombre) et **Équipements en alerte** (niveau alerte ; un équipement dont la mesure est inconnue n'est pas compté). Les alertes des équipements remontent sur Alertes et Problème de Homelab Manager.

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
| APT | avertissement | Home Assistant OS ou Core à mettre à jour (hôtes HAOS) |
| Docker | avertissement | Stack partielle (une partie des conteneurs seulement tourne) |
| Docker | avertissement | Conteneur en mauvaise santé (`unhealthy`) |
| Docker | avertissement | Conteneur qui redémarre en boucle |
| Onduleur | critique | Batterie à remplacer, alarme, sur batterie, batterie faible, surcharge, arrêt forcé |
| Onduleur | avertissement | Charge ou autonomie sous le seuil NUT, auto-test en échec, statut inhabituel |
| Services | critique | Sonde hors service (les sondes inconnues ne comptent pas) |

« Paquets à nettoyer » n'apparaît qu'avec un agent récent (0.1.1 et plus) : l'agent annonce au hub ce qu'il sait faire.

Une stack arrêtée volontairement ne déclenche pas d'alerte. Les prochains composants (sauvegardes…) s'ajouteront comme sous-composants de l'hôte, avec leurs propres alertes remontées de la même façon.

## Sécurité des commandes

Le hub ne sait pas qui publie sur le broker : toute commande reçue sur `PREFIXE/APPAREIL/ENTITE/set` est exécutée, sans compte sur le hub. C'est pourquoi seules les **mises à jour** sont publiées en actions (catégorie *Actions*, incluse dans le niveau *Complet*) :

- recherche et installation des mises à jour APT ;
- vérification et mise à jour des images d'une stack (`docker compose pull` + `up -d`) ;
- mise à jour de l'agent (binaire signé).

Ni redémarrage d'un hôte, ni arrêt, démarrage ou redémarrage d'une stack, ni nettoyage des paquets : ces actions se lancent depuis le hub. Chaque commande reçue est écrite dans le journal du hub (topic, action, hôtes) et le job apparaît dans l'activité avec la mention « Home Assistant ».

Le hub signale un broker qui accepte les **connexions anonymes** (rôle Broker MQTT et page Home Assistant) : n'importe qui sur le réseau peut alors lancer ces mises à jour. Sur Mosquitto, désactiver l'accès anonyme et réserver l'écriture des commandes au compte de Home Assistant :

```
# mosquitto.conf
allow_anonymous false
password_file /mosquitto/config/passwd
acl_file /mosquitto/config/acl

# acl
user homeassistant
topic readwrite homeassistant/#
topic write homelab-manager/+/+/set
topic read homelab-manager/#

user homelab-manager
topic readwrite homelab-manager/#
topic readwrite homeassistant/#
```

Adapter `homelab-manager` au préfixe des états choisi, et donner aux autres clients (Zigbee2MQTT, ESPHome…) leur propre compte, sans écriture sur ces topics.

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
