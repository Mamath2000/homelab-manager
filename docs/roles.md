---
id: roles
title: Rôles du hub
description: "Ce que le hub peut faire au travers d'un élément du homelab (broker MQTT, cluster Proxmox VE) : déclaration, hôte porteur, test, réaffectation"
sidebar_position: 3.95
---

# Rôles du hub

Un **rôle** est ce que le hub fait au travers d'un élément du homelab : écouter un broker MQTT, relever un cluster Proxmox VE. Chaque rôle est **porté par un hôte** et déclaré par un administrateur dans **Paramètres › Rôles** ; sans rôle, ce qui en dépend est inactif (pas de sonde MQTT, pas de pont Home Assistant, pas d'inventaire Proxmox VE).

:::note Rôles et profils
Les droits d'un compte s'appellent des **profils** (`admin`, `operator`, `viewer`, voir [Comptes et profils](comptes.md)) : le mot « rôle » ne désigne que ce qui est décrit ici.
:::

## Types

| Type | Porteur | Plusieurs ? | Utilisé par |
|---|---|---|---|
| **Broker MQTT** (`mqtt-broker`) | un hôte dont l'agent a détecté un broker en écoute | oui, un par `(hôte, port)` | [sondes MQTT](sondes.md#brokers-mqtt), pont [Home Assistant](home-assistant.md) |
| **Cluster Proxmox VE** (`pve-cluster`) | un nœud (hôte avec la capacité Proxmox VE) | oui, un par cluster | [inventaire](proxmox-ve.md) et [sauvegardes](sauvegardes.md#clusters-proxmox-ve) |
| **PBS principal** (`pbs-primary`) | l'hôte du Proxmox Backup Server (son agent, PBS installé ou en conteneur) | non, un seul | les [sauvegardes](sauvegardes.md) : groupes relevés, jobs des agents, montages |
| **PBS hors site** (`pbs-offsite`) | l'hôte du PBS distant | non, un seul, **après** le PBS principal | la [copie déportée](sauvegardes.md) des sauvegardes choisies |
| **Contrôleur Omada** (`omada-controller`) | un **hôte** (contrôleur en Docker, détecté par l'agent sur ses ports de service) ou un **équipement** avec une adresse IP (contrôleur dédié, OC200…) | oui | Paramètres › Omada : [équipements](equipements.md#omada) synchronisés et [sondes VPN](sondes.md#sondes-vpn) |

Le contrôleur Omada est le seul rôle qu'un **équipement** peut porter : il passe par une API (adresse, empreinte du certificat épinglée, application Open API en mode client), sans agent. Sans contrôleur déclaré, l'onglet Paramètres › Omada n'apparaît pas et rien n'est relu.

Les deux PBS se déclarent et se modifient par leur fenêtre (hôte, détection, jetons créés par l'agent, test, voir [Sauvegardes](sauvegardes.md#mise-en-place)) ; **Supprimer** l'un d'eux est sa [déconnexion](sauvegardes.md#déconnecter-un-pbs-ou-un-cluster), et celle du principal entraîne le hors site. Sans PBS principal, la page Sauvegardes et les jobs renvoient vers sa déclaration. Leurs réglages restent stockés avec les sauvegardes (`settings.pbs`, `settings.pbs-remote`) : ils deviennent des rôles une fois connectés, sans migration.

Les rôles sont **groupés par type** dans Paramètres › Rôles ; le contrôleur Omada y affiche l'état de son dernier relevé (sites, appareils, VPN).

Un rôle de type broker n'est jamais saisi à la main : l'agent de l'hôte signale ce qu'il voit en écoute, l'administrateur le déclare. Un rôle Cluster Proxmox VE reçoit son jeton `PVEAuditor` de l'agent du nœud porteur (voir [Sauvegardes](sauvegardes.md#jeton-de-proxmox-ve--créé-par-lagent-dun-nœud)).

## Déclarer un rôle

**Paramètres › Rôles › Déclarer un rôle** ouvre un assistant en étapes (**Type › Hôte › Paramètres › Test**). L'enregistrement exige un **test de connexion** réussi ; le mot de passe n'est jamais renvoyé par l'API. Chaque rôle porte un **nom** (son identifiant dans les sondes) et affiche ce qui l'utilise.

Sur la fiche d'un hôte ou d'un équipement, les rôles qu'il porte s'affichent (lien vers Paramètres › Rôles) ; sur un hôte, et un broker détecté par son agent se déclare d'un clic (**Déclarer**, assistant prérempli).

### Empreinte du contrôleur Omada

Le certificat d'un contrôleur Omada est auto-signé : le hub n'accepte que celui dont l'empreinte SHA-256 est épinglée. **Lire l'empreinte du contrôleur** (étape **Contrôleur**), ou un test refusé pour cause de certificat, propose l'empreinte que présente le contrôleur ; elle n'est épinglée qu'au clic sur **Épingler l'empreinte**. Elle est vérifiée selon le porteur :

| Porteur | Vérification | Affichage |
|---|---|---|
| Hôte dont l'agent est à jour (agent 1.2.0 ou plus, capacité `tls_fingerprint`) et connecté | l'agent lit le certificat **sur l'hôte** (adresse de l'URL si c'est une adresse de l'hôte, sinon `127.0.0.1`, même port) et le hub le compare à celui vu par le réseau | vert : identiques, épinglable |
| idem, certificats différents | interception entre le hub et le contrôleur, ou l'adresse n'est pas celle de cet hôte (proxy, autre machine) | rouge : les deux empreintes, **pas d'épinglage** ; l'API refuse aussi d'enregistrer (409) une empreinte que l'agent ne lit pas |
| Équipement (OC200…), agent ancien ou hors ligne, lecture de l'agent en échec | rien à comparer | orange : à comparer **avant** d'épingler, avec le cadenas du navigateur sur l'interface du contrôleur, ou sur sa machine : `openssl s_client -connect 127.0.0.1:8043 </dev/null 2>/dev/null \| openssl x509 -noout -fingerprint -sha256` |

L'agent ne lit jamais que l'hôte lui-même, il ne contacte pas une autre machine. Une empreinte déjà épinglée et inchangée reste modifiable sans nouvelle vérification (renommage, application) ; changer d'empreinte ou de porteur la revérifie.

## Sécurité d'un broker MQTT (dynamic-security)

Pour un broker **Mosquitto 2.1 ou plus**, le hub peut gérer la sécurité par le plugin `dynamic-security`, **sans script ni SSH** : tout est fait par l'agent de l'hôte. La liste des rôles indique pour chaque broker si la gestion des comptes est **indisponible** (Mosquitto plus ancien, autre broker, agent à mettre à jour), **disponible** ou **gérée par le hub** ; dès qu'un broker l'offre, l'onglet **Paramètres › MQTT** apparaît (un panneau par broker), comme Proxmox VE ou Omada avec leur rôle.

Le panneau montre les contrôles de l'agent avant toute activation. Elle est refusée si le broker ne tourne pas sous systemd, si la configuration n'a pas de `include_dir` ni de `listener` explicite, ou si elle définit déjà `password_file`, `acl_file`, `per_listener_settings true` ou un autre plugin d'authentification.

**Activer la gestion des comptes** (confirmation, puis passkey si le compte en a une) :

1. le hub émet avec sa CA un certificat serveur (noms : les IP de l'hôte) et un certificat client pour son compte `hlm` ; la clé du compte reste au hub ;
2. l'agent ajoute, sans toucher à vos fichiers, `/etc/mosquitto/hlm-tls/` et `conf.d/zz-hlm-dynsec.conf` (plugin, listener 8883 en TLS mutuel, `log_dest topic`), puis redémarre le broker ;
3. il crée le rôle `legacy` (tous les topics) sur le groupe anonyme, le compte `hlm` authentifié par son certificat, et supprime le compte d'initialisation ;
4. le hub se connecte en TLS mutuel (`mqtts://…:8883`) pour vérifier. S'il n'y arrive pas, l'agent annule tout.

**Deux connexions distinctes.** Le hub administre le broker avec **son identité** (port 8883, certificat du compte `hlm`), gardée à part dans le rôle. La **connexion du rôle** (adresse, schéma, port, compte) — celle que les sondes et le pont Home Assistant utilisent — **n'est jamais modifiée** par l'activation : un rôle créé en anonyme sur le port 1883 continue de marcher tel quel, sans être recréé.

:::warning Comptes inconnus refusés
Une fois dynamic-security actif, **une connexion avec un utilisateur que le broker ne connaît pas est refusée** (un appareil mal configuré ne se connecte plus). Les connexions **anonymes** restent acceptées. Le broker est redémarré : tous ses clients sont déconnectés quelques secondes.
:::

**Comptes.** L'activation se règle dans Paramètres › MQTT ; les comptes se gèrent depuis la **fiche de l'hôte** qui porte le broker, dans le cadre **MQTT géré par HLM** (nombre de comptes enregistrés, de comptes connectés, de clients refusés) dont le bouton **Gérer les comptes** ouvre une fenêtre qui liste les comptes du broker avec leur **état de connexion** (connecté, nombre de connexions). On peut **ajouter** un compte (nom et mot de passe, **généré** si on n'en saisit pas), **changer son mot de passe** et le **supprimer** ; le mot de passe n'est affiché qu'une fois, à sa création ou à son changement. Les **clients refusés** (identifiant inconnu ou mauvais mot de passe) apparaissent en tête de la même liste, en rouge, avec leur **identifiant de client**, leur adresse et le nombre de tentatives, relevés dans le journal que le broker publie sur `$SYS/broker/log/#` ; le bouton **Créer** en bout de ligne ouvre la création du compte (le journal ne donne pas le nom d'utilisateur essayé : il se saisit, préenrichi de l'identifiant du client). La croix en bout de ligne **retire** un client de la liste, et **Retirer tous les clients refusés** vide les clients refusés et anonymes (utile quand un client change d'identifiant à chaque tentative) ; ils reviennent à leur prochaine tentative. La liste se **filtre** par type (tous, en erreur — refusés et anonymes sans droits —, anonymes, comptes, avec leur nombre) et par texte (identifiant de client, compte ou adresse), et s'affiche par **pages de 15 lignes**. Seul le **dernier message** du journal compte pour un identifiant de client : une connexion réussie le retire de la liste, et un compte créé depuis la liste le laisse affiché (« en attente de connexion », ou « toujours refusé » si le client est refusé de nouveau, nom ou mot de passe à vérifier) jusqu'à la première connexion qui passe. Cette liste est gardée en mémoire par le hub (sept jours au plus, vidée au redémarrage). Les **clients anonymes** (connectés sans nom d'utilisateur, ce que le journal du broker distingue d'une connexion avec un compte) sont listés aussi, avec leur identifiant de client, leur adresse et leur état (connecté ou non) : c'est ce qui permet de savoir qui reste à migrer avant de leur retirer les droits ; **Créer** leur prépare un compte, et ils quittent la liste dès qu'ils se connectent avec un compte. Au démarrage du hub, l'agent de l'hôte lui envoie la fin du fichier journal du broker (si le broker écrit dans un fichier, `log_dest file`) pour reconstituer qui était connecté ou refusé avant ; sans cela, seuls les événements postérieurs sont vus. Le compte du hub (`hlm`, par certificat) est affiché mais jamais modifiable. Un compte donne pour l'instant accès à **tous les topics** (rôle `hlm-full`) : les droits par topic ne sont pas encore gérés. Ces actions demandent le passkey et sont inscrites au journal d'audit, sans mot de passe.

**Connexion du rôle.** Dans Paramètres › MQTT, le bloc **Connexion du rôle** rappelle l'adresse et le compte que les sondes et le pont Home Assistant utilisent. **Définir le compte de la connexion** crée sur le broker un compte nommé `hlm-<identifiant du rôle>` (accès à tous les topics, mot de passe saisi ou **généré**, affiché une fois) et l'écrit dans le rôle, qui n'est pas recréé : sondes et pont se reconnectent seuls. Redemandé, il change le mot de passe. Pour un compte existant que l'on préfère, le créer dans **Gérer les comptes** puis le saisir dans le rôle (**Paramètres › Rôles**). La connexion reste sur le listener d'origine (1883 en général) : le port 8883 de l'agent exige un certificat client et n'accepte pas un simple nom et mot de passe.

**Clients anonymes.** La case **Accepter les connexions anonymes** (Paramètres › MQTT, une fois la gestion activée) décide si le broker accepte les connexions sans compte. Cochée, elles se font avec les droits du rôle `legacy` (tous les topics). Décochée, l'agent écrit `allow_anonymous false` dans le fichier qu'il a ajouté à la configuration du broker et **redémarre le broker** quelques secondes : une connexion sans compte est alors **refusée** (« not authorised »), et l'appareil apparaît dans les clients refusés avec son identifiant, prêt pour **Créer**. La confirmation liste les clients anonymes encore connectés. Si le broker ne repart pas, l'agent remet le fichier d'avant et redémarre ; si le hub ne peut plus joindre le broker ensuite, le changement est annulé. Le rôle `legacy` reste en place : recocher la case rétablit exactement l'état d'avant. L'avertissement « connexions anonymes acceptées » de la liste des rôles suit cet état.

**Désactiver** retire les fichiers ajoutés et redémarre le broker avec sa configuration d'origine ; l'état du plugin (comptes, rôles) est conservé à côté, daté, sur l'hôte. La connexion du rôle n'est pas touchée. Le certificat client du hub est valable un an.

## Réaffecter, supprimer

- **Réaffecter** : modifier le rôle et choisir un autre hôte porteur, paramètres conservés (pour un cluster Proxmox VE, un autre nœud **du même cluster**). Un hôte porteur hors ligne ne déplace rien tout seul : le relevé passe en erreur, comme avant, et la réaffectation reste manuelle.
- **Supprimer** : refusé tant qu'une sonde ou le pont Home Assistant utilise le rôle. Supprimer **un hôte ou un équipement porteur** est refusé tant qu'il porte un rôle (la confirmation de suppression le dit et renvoie vers Paramètres › Rôles).
- Redémarrer ou arrêter un hôte porteur affiche un avertissement qui nomme les rôles concernés.

## Migration

Au premier démarrage d'une version avec les rôles, le hub reprend l'existant sans rien demander :

- les brokers MQTT des anciennes options d'hôte deviennent des rôles (**même identifiant** : les sondes qui les citent continuent de marcher) ;
- les clusters de Paramètres › Sauvegardes deviennent des rôles Cluster Proxmox VE, avec leur jeton ;
- le broker du pont Home Assistant est rattaché au rôle de même adresse et de même compte, sinon il reste « à rattacher » (voir [Home Assistant](home-assistant.md#relier-un-broker)) ;
- le champ `role` des comptes devient `profile` (le champ JSON de `/api/users` et du compte connecté suit).

:::warning Pas de retour en arrière
La migration des comptes est à sens unique : une version antérieure du hub ne retrouverait pas le champ `role` et passerait tous les comptes en `admin`. Sauvegarder la base avant la mise à jour.
:::

## API

Administrateurs seulement, sauf mention contraire.

| Route | Rôle de la route |
|---|---|
| `GET /api/roles` | rôles avec hôte porteur, état de la connexion et `uses` (ce qui les utilise) ; le mot de passe n'est jamais renvoyé |
| `POST /api/roles` | déclarer un rôle (`type`, `carrier`, `name`, `config`) |
| `PUT /api/roles/:id` | modifier ou réaffecter (`carrier`) |
| `DELETE /api/roles/:id` | supprimer (`409` si utilisé) |
| `POST /api/roles/test` | tester la connexion d'un rôle en cours de saisie |

`GET /api/settings/pve` et `/api/settings/pve/*` restent les routes des clusters Proxmox VE (relevé, jeton, test, déplacement) et travaillent sur les rôles.
