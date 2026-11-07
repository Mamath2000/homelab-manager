# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/). L'historique complet est dans git et les tags `v*`. La section « Non publié » liste ce qui suit la dernière version promue en prod : `make docker-promote` la renomme en version et en fait les notes de la release GitHub.

## Non publié

### Sécurité

- **Dépendances vulnérables corrigées** : hub (`smol-toml`, `fastify`, `@fastify/static`/`glob`, `minimatch`, `ip-address`, `fast-uri` : `npm audit` propre), interface (`vite`, `zod`, `minimatch` : `npm audit` propre) et agent compilé avec Go 1.27.3 au lieu de 1.24.4 (37 failles de la bibliothèque standard atteintes par l'agent, dont `net/http`, `crypto/tls` et `crypto/x509`) et `golang.org/x/sys` 0.44.0 ; `govulncheck` propre. (homelab#297)
- **Accès root et utilisateur sudo par manifeste signé hors ligne** : les clés SSH de root, l'utilisateur sudo (et son sudo sans mot de passe) et ses clés ne sont plus des valeurs saisies dans le hub. Elles viennent d'un manifeste signé sur le poste de l'administrateur (`make access-manifest`, `ssh-keygen -Y sign`, clé FIDO possible), que le hub relit dans un dossier monté en lecture seule (`./access`, déposé par `make access-publish`) et relaie (Paramètres › Standardisation › Accès). Chaque agent vérifie la signature avec sa propre ancre (`access-anchor.json`, hors de portée du hub), refuse un numéro de série plus ancien (rejeu), ne retire que les clés qu'il a posées et remonte l'inventaire des `authorized_keys` (clés inconnues signalées). L'ancre est posée au premier manifeste valide reçu pendant une fenêtre de 14 jours après la mise à jour de l'agent (migration), puis plus jamais par le hub. Sans manifeste valide, les options « Clés SSH » et « Compte » n'appliquent rien. (homelab#312)
- **Base de données protégée (options)** : compte MongoDB (`MONGO_USERNAME`, `MONGO_PASSWORD`) et clé maître (`HM_MASTER_KEY`) qui chiffre les secrets stockés (autorité des agents, jetons PBS, PVE et Omada, mot de passe MQTT), réglés dans un `.env` ; MongoDB sur un réseau interne joignable par le hub seulement. Sans `.env`, rien ne change. Une base chiffrée ne démarre pas sans sa clé. Voir [Migrer une installation existante](docs/securite.md#migrer-une-installation-existante). (homelab#288)
- **Commandes depuis Home Assistant limitées aux mises à jour** : le pont MQTT ne publie et n'exécute plus le redémarrage d'un hôte, l'arrêt, le démarrage ou le redémarrage d'une stack, ni le nettoyage des paquets (le broker ne dit pas qui publie). Chaque commande reçue est journalisée ; un broker qui accepte les connexions anonymes est signalé sur son rôle et sur la page Home Assistant. Les automatisations HA qui utilisaient ces boutons sont à revoir. Voir [Sécurité des commandes](docs/home-assistant.md#sécurité-des-commandes). (homelab#287)
- **Standardisation réservée aux admins** : les opérateurs ne modifient plus les choix de standardisation d'un hôte (clés SSH, compte, alias…), ils vérifient et appliquent les valeurs réglées par un admin. (homelab#286)
- **Politique locale de l'hôte** (`/etc/homelab-agent/policy.json`, hors de portée du hub) : installation d'agents depuis un nœud Proxmox VE, dossiers jamais sauvegardés, PBS autorisés ou épinglés au premier usage, images du client de sauvegarde. L'agent écrit la politique stricte au démarrage quand le fichier manque (nouvelle installation ou mise à jour) ; elle s'assouplit à la main sur l'hôte. Une sauvegarde de `/`, `/etc` ou `/root` en exclut les dossiers interdits, une archive située dans l'un d'eux est refusée, et le PBS est épinglé à la première sauvegarde. Elle est affichée en lecture seule sur la fiche de l'hôte, et les hôtes qui refuseront un nouveau PBS principal sont signalés dans Paramètres › Rôles. Voir [Politique locale](docs/securite.md#politique-locale-de-lhôte).
- **Image du client de sauvegarde épinglée** : l'agent de release embarque l'image par son digest et refuse les autres ; une image personnalisée est à ajouter à `backup.images`.
- **Installation de l'agent depuis Proxmox VE sans script du hub** : le nœud copie son propre binaire signé dans le CT ou sur l'autre nœud et lance `homelab-agent install` ; curl n'est plus nécessaire dans le CT.

### Ajouté

- **Home Assistant : équipements et appareils de site** : un appareil par équipement (alertes, une entité par sonde, adresse IP), catégorie **Équipements** aux niveaux Standard et Complet, comptés (Équipements, Équipements en alerte) et remontés sur Homelab Manager. Nouvelle case **Regrouper les entités par site** : un appareil par site entre Homelab Manager et ses hôtes / équipements. Voir [Appareils créés](docs/home-assistant.md#appareils-créés). (homelab#250)
- **Documentation : page « Audit de sécurité »** : bilan, précautions et corrections prévues, voir [Audit de sécurité](docs/audit-securite.md).
- **Tableau des équipements** : colonnes redimensionnables.
- **Documentation orientée utilisateur** : README refondu, nouvelles pages [Démarrage rapide](docs/demarrage-rapide.md), [Les notions clés](docs/concepts.md), [Créer des éléments](docs/creer-des-elements.md) et [Suivi des sauvegardes](docs/suivi-des-sauvegardes.md) (Proxmox VE, PBS, Home Assistant OS), nouvelles captures d'écran ; architecture, API et release déplacées dans [Développement](docs/developpement.md).
- **Régénération des jetons PBS des hôtes** : bouton **Régénérer le jeton** dans la section Accès PBS d'un hôte, et actions groupées, depuis la sélection de la liste
  des hôtes ou sur le PBS principal (Paramètres › Rôles), avec aperçu des cibles. Le nouveau secret garde le même identifiant, est transmis à l'agent sans
  intervention et n'est jamais affiché. Un hôte hors ligne n'est pas régénéré. Voir [Régénérer le jeton d'un hôte](docs/sauvegardes.md#régénérer-le-jeton-dun-hôte). (homelab#205)
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
- **Omada comme source d'équipements** (Paramètres › Omada, visible dès qu'un rôle contrôleur Omada existe) : appareils du
  contrôleur relus toutes les 5 minutes, présentés site par site avec le site du homelab associé à chaque site Omada. Un appareil
  devient un équipement (nom modifiable) ou se relie à un équipement manuel de même IP ou de même nom ; il reçoit alors un ping
  et une sonde « Interface web » (HTTPS), et ses checks natifs : connexion au contrôleur, charge processeur et mémoire
  (avertissement dès 85 %, alerte dès 95 %). Bouton Actualiser sur la fiche d'un équipement de source automatique. L'équipement
  amont reste à saisir à la main. (homelab#231)
- **Sondes ping depuis un hôte** : une sonde ping se mesure depuis le hub ou depuis l'agent d'un autre hôte (op `ping`,
  capacité `ping`), jamais l'hôte vérifié. Source supprimée : hors service avec « source à choisir ». L'assistant d'une sonde
  passe en quatre étapes : type et nom, origine, cible (hôte ou équipement avec IP pour un ping), options et test. (homelab#260)
- **VPN site à site et sondes VPN** : les tunnels IPsec d'Omada sont relus à chaque relevé et listés en tête de Paramètres ›
  Omada ; check natif « Tunnel _nom_ » sur la passerelle ; une sonde VPN par tunnel, portée par la passerelle : un hôte des
  réseaux locaux pingue (depuis cette adresse, `ping -I`, agent 1.0.8, capacité `ping_from`) une machine des réseaux distants,
  candidats filtrés par adresse, candidat unique choisi seul, non configurée = hors service, tunnel désactivé = en pause.
  Voir [Sondes VPN](docs/sondes.md#sondes-vpn). (homelab#261)
- **Rôle porté par un équipement** (contrôleur Omada dédié) : ses rôles s'affichent sur la fiche de l'équipement, et sa
  suppression est refusée tant qu'il en porte, comme pour un hôte. Voir [Rôles du hub](docs/roles.md). (homelab#257)
- **Équipements** : en-tête comme celui des hôtes (matrice sites × types, état des équipements et des sondes, à traiter),
  filtres par site et par état.
- Équipements et tableau de bord, graphiques, menu de gauche et volet flottant revus ; corrections d'affichage mobile et tablette
  (homelab#239 à #249).

### Corrigé

- **Omada : faux « Tunnel … non établi »** : le check natif d'un tunnel VPN site à site ne passe plus en alerte sur un seul relevé sans associations de sécurité (un rekey IPsec en retire une quelques secondes) mais après 3 relevés consécutifs (15 min). La sonde VPN du tunnel signale toujours une vraie coupure en moins de 2 min. Voir [Sondes VPN](docs/sondes.md#sondes-vpn).
- Sondes : quand la cible (ou l'hôte d'exécution) d'une sonde change, l'état et la mesure précédents sont écartés, et une mesure en cours sur l'ancienne cible
  est ignorée ; la sonde est remesurée au tick suivant.
- Sauvegardes : le nom d'une archive invalide (lettres, chiffres, `-` et `_`, 64 caractères max) est signalé dans la fenêtre de sauvegarde (onglet Contenu)
  avant l'enregistrement, au lieu d'un refus du hub.
- Sonde HTTP : une réponse avec à la fois `Content-Length` et `Transfer-Encoding` (interface web des routeurs Omada) n'est plus
  en échec « Parse Error ».

### Modifié

- Les rôles des **comptes** (`admin` / `operator` / `viewer`) deviennent des **profils** : champ `UserDoc.profile`, champ JSON
  `profile` de `/api/users` et du compte connecté, libellés de l'interface.
- Le pont Home Assistant publie sur un rôle `mqtt-broker` (`brokerRoleId`) ; sans rôle sélectionné, il est désactivé.
- La fiche d'un équipement reprend la bande horizontale et les boutons carrés (actualiser, options, supprimer) de la fiche d'un hôte.
- Les clusters Proxmox VE, le **PBS principal** et le **PBS hors site** se déclarent comme rôles (un seul PBS de chaque, le
  hors site après le principal ; Supprimer = déconnexion). L'onglet **Paramètres › Sauvegardes** disparaît ; l'état de la
  série de copies passe sur la carte « PBS secours » de la page Sauvegardes. (homelab#256, #252)
- Paramètres › Rôles : rôles groupés par type ; le contrôleur Omada affiche l'état de son dernier relevé au lieu d'« Inactif ».
- Paramètres › Proxmox VE : colonnes alignées d'un nœud à l'autre.

### Migration

- Migrations automatiques au démarrage : `role` → `profile` des comptes, rattachement de l'ancien broker du pont Home Assistant
  au rôle de même adresse et de même compte (sinon « à rattacher »).
- **Pas de retour en arrière** vers une version antérieure : son ancienne migration passerait tous les comptes en `admin`.
  Sauvegarder la base MongoDB avant la mise à jour.
