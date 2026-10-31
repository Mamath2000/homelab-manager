---
title: Sondes de service
description: Vérifier de l'extérieur qu'un service rend bien le service (MQTT, ping, TCP, HTTP, VPN site à site) depuis le hub ou depuis un hôte avec agent, sur un hôte ou un équipement, brokers MQTT, états, alertes, Home Assistant
sidebar_position: 3.7
---

# Sondes de service

Une **sonde** vérifie, depuis le hub, qu'un service est réellement rendu : un port qui répond, une page qui contient le bon texte, un appareil Zigbee ou ESPHome qui se déclare en ligne. C'est le complément de ce que l'agent rapporte de l'intérieur de l'hôte (Docker dit qu'un conteneur tourne, la sonde dit que le service répond).

Les sondes remplacent les moniteurs d'Uptime Kuma. Elles se rattachent à un **hôte**, éventuellement à l'une de ses **stacks Docker**, ou à un **[équipement](equipements.md)** (switch, passerelle, module domotique…), et alimentent le domaine **Services** des [alertes et statuts](alertes.md).

## Les types

| Type | Ce qui est vérifié | Réglages |
|---|---|---|
| **MQTT** | le dernier message d'un topic d'un [broker MQTT](#brokers-mqtt) | topic exact (pas de joker `+` ni `#`) ; texte attendu dans le message, facultatif |
| **Ping** | l'adresse répond à un ping, depuis le hub ou depuis un hôte avec agent | origine (le hub ou un hôte), cible (un hôte ou un équipement avec une adresse IP) |
| **TCP** | le port accepte la connexion | nom ou adresse IP, port |
| **HTTP(S)** | l'URL répond comme attendu | code attendu (par défaut n'importe quel 2xx), mot-clé attendu dans la réponse, certificat non vérifié pour un certificat auto-signé |
| **VPN** | le trafic passe dans un tunnel site à site d'Omada | créée par le hub, voir [Sondes VPN](#sondes-vpn) : source et cible |

- **MQTT, texte attendu** : le dernier message du topic doit le contenir. Un statut retenu (*retained*) reste valable tant qu'il n'est pas remplacé, comme la disponibilité Zigbee2MQTT (`online`) ou le dernier mot d'ESPHome. Sans texte attendu, un message doit être arrivé dans le délai maximal.
- **HTTP** : les redirections (jusqu'à 5) sont suivies, sauf quand le code attendu est justement celui de la redirection. Seul le début de la réponse est lu (1 Mo au plus), uniquement pour chercher le mot-clé. Une réponse qui porte à la fois `Content-Length` et `Transfer-Encoding` (interface web de certains routeurs) est relue avec le parseur tolérant de Node : le service répond, la sonde est en ligne.
- **Ping depuis le hub** nécessite la commande `ping` dans le conteneur du hub et l'autorisation d'envoyer de l'ICMP. Si ce n'est pas possible, la sonde est **inconnue** avec le message « ping non autorisé dans le conteneur du hub » (ou « commande ping absente du hub »), jamais en échec : le service n'est pas jugé.
- **Ping depuis un hôte** : l'**agent** de cet hôte (Linux, capacité `ping`) mesure et répond au hub, par exemple pour éprouver un lien entre deux sites. Jamais l'hôte auquel la sonde est rattachée. Hôte source hors ligne ou agent trop ancien : **inconnu**. Hôte source **supprimé** : **hors service** tout de suite, sans nouvelle tentative, avec « source supprimée : à choisir », pour qu'un administrateur la remplace.

## États

| État | Sens | Couleur |
|---|---|---|
| **En ligne** (`up`) | la dernière mesure est bonne | vert |
| **Hors service** (`down`) | la mesure échoue, après les nouvelles tentatives | rouge (alerte) |
| **Inconnu** (`unknown`) | la mesure est impossible : broker MQTT injoignable, ping non autorisé, hôte itinérant absent, pas encore mesurée | gris, ne compte pas dans le niveau de l'hôte |

Un **échec réseau vers la cible** (connexion refusée, délai dépassé, mauvais code HTTP) est toujours « hors service ». « Inconnu » est réservé aux cas où la mesure elle-même est impossible.

- **Intervalle** : 60 s par défaut (10 s à 1 h). **Délai maximal** : 10 s par défaut (1 à 60 s), qui ne peut pas dépasser l'intervalle.
- **Nouvelles tentatives** : 0 à 3 mesures en échec de suite avant de passer « hors service ». Entre-temps, la sonde garde son état précédent.
- Une sonde n'est jamais masquée par l'état de l'hôte : un hôte hors ligne a quand même ses sondes. Seul un [hôte itinérant](alertes.md#hôte-itinérant-absent) absent les met en gris.
- **Pas d'historique de mesures** : le hub ne garde que l'état courant, la durée de la dernière mesure et le moment du dernier changement. Les changements d'état alimentent la frise des alertes de la fiche hôte (domaine Services) et mettent aussitôt à jour l'interface et Home Assistant.
- Les mesures sont limitées à 8 en parallèle ; une seule connexion MQTT est ouverte par broker, partagée par toutes les sondes qui l'écoutent, avec un abonnement par topic.

## Sondes d'un hôte

Dans la **fiche de l'hôte**, le panneau **Sondes** (après Docker) liste ses sondes : nom, type et cible (avec la stack éventuelle), état (avec le temps de réponse de la dernière mesure) et depuis quand il a changé. **Ajouter une sonde** ouvre une fenêtre en quatre étapes :

1. **Type et nom**.
2. **Origine** : le hub, ou pour un ping un hôte dont l'agent sait pinguer.
3. **Cible** selon le type ; pour un ping, un hôte ou un équipement qui a une adresse IP (liste filtrable).
4. **Options et test** : stack éventuelle, intervalle, délai maximal, nouvelles tentatives, puis une mesure immédiate depuis l'origine choisie, sans enregistrer. L'enregistrement ne demande pas de test réussi : une sonde peut être créée pour un service pas encore installé.

L'ajout et la modification se font sans confirmation ; la suppression en demande une. Tous les profils voient les sondes d'un hôte ; seuls les **administrateurs** les ajoutent, les modifient, les testent et les suppriment, et gèrent les brokers.

## Sondes d'un équipement

La fiche d'un [équipement](equipements.md) a le même panneau **Sondes**, sans choix de stack. Une nouvelle sonde ping ou TCP reprend l'adresse IP de l'équipement, et changer cette adresse déplace les sondes ping et TCP qui visaient l'ancienne. La suppression d'un équipement supprime ses sondes.

:::info Stack supprimée
Quand une stack disparaît du rapport Docker de son hôte, ses sondes sont **supprimées** (elles ne feraient que passer en échec) et l'interface le signale par un message. Les sondes de l'hôte lui-même ne sont pas touchées. La suppression d'un hôte supprime toutes ses sondes.
:::

## Sondes VPN

Un tunnel IPsec peut être **établi** selon le contrôleur sans que le trafic passe (sélecteurs de trafic, routes, ACL). La sonde VPN vérifie le trafic réel : un **hôte** des réseaux que le tunnel transporte de ce côté pingue, par son agent, une **machine** des réseaux de l'autre côté.

- Le hub relit les tunnels site à site de chaque [contrôleur Omada](equipements.md#omada) à chaque relevé (5 min) et crée **une sonde par tunnel**, sur la **passerelle** qui le porte, dès qu'elle est un équipement. Un tunnel relie deux sites : chaque passerelle a la sienne, donc une sonde par sens.
- **Source** : un hôte dont une adresse est dans les **réseaux locaux** du tunnel ; le ping part de cette adresse (`ping -I`, agent 1.0.8 ou plus, capacité `ping_from`), pour entrer dans le tunnel même sur un hôte à plusieurs adresses. **Cible** : un hôte ou un équipement dont l'adresse est dans les **réseaux distants** ; la passerelle distante est proposée en premier, c'est la cible la plus stable.
- Les candidats sont filtrés **par adresse**, jamais par le site du hub : un hôte rattaché à un site mais qui tourne sur un autre réseau n'est pas proposé.
- Rien n'est choisi par défaut, sauf quand il n'y a qu'**un seul candidat**. Le choix se fait dans **Paramètres › Omada › VPN site à site** (bouton **Configurer**) ou depuis la fiche de la passerelle (Modifier), en quatre étapes : tunnel, source, cible, test.

| Situation | État | Message |
|---|---|---|
| Source ou cible pas encore choisie, source supprimée | hors service, tout de suite | « source à choisir », « cible à choisir », « source supprimée : à choisir » |
| Source ou cible sortie des réseaux du tunnel | hors service, tout de suite | « … hors des réseaux locaux / distants du tunnel » |
| Tunnel désactivé dans Omada | inconnu, **en pause** (pas de mesure) | « tunnel désactivé dans Omada : sonde en pause » |
| Hôte source hors ligne | inconnu | |
| Le ping échoue | hors service (après 1 nouvelle tentative) | complété par « tunnel établi selon Omada » ou « tunnel non établi selon Omada » |

- Un tunnel **supprimé** dans Omada supprime sa sonde (l'interface le signale). Une sonde VPN ne se supprime pas à la main : elle suit son tunnel. Une lecture des tunnels en échec ne supprime rien.
- Intervalle 60 s, délai 5 s, 1 nouvelle tentative (un paquet perdu dans un tunnel n'est pas une panne).
- La passerelle porte aussi un **check natif** par tunnel activé, « Tunnel _nom_ » (domaine Connexion), en alerte quand le contrôleur n'a pas d'associations de sécurité en entrée et en sortie : on lit côte à côte « établi selon Omada » et « le trafic passe ».

## Brokers MQTT

Les sondes MQTT écoutent leurs propres brokers, **distincts du broker du pont [Home Assistant](home-assistant.md)** (par exemple celui de Zigbee2MQTT et celui d'ESPHome d'un site). Un broker est un **rôle `Broker MQTT`** porté par l'hôte qui l'héberge : l'agent de l'hôte signale les brokers qu'il voit en écoute, et un administrateur les déclare dans **Paramètres › Rôles** (assistant **Type › Hôte › Paramètres › Test**). Il faut donc un agent HLM sur l'hôte du broker. Les rôles sont décrits dans [Rôles du hub](roles.md).

Un rôle porte un nom (l'identifiant que les sondes citent), le schéma (`mqtt://`, `mqtts://`, `ws://` ou `wss://`), le port, une adresse facultative (par défaut la première IP privée de l'hôte) et un compte facultatif (broker anonyme). Comme pour Home Assistant, l'enregistrement exige un **test de connexion** réussi, et le mot de passe n'est jamais renvoyé par l'API.

**Paramètres › Rôles** donne la vue d'ensemble : état de la connexion de chaque broker (connecté, connexion, injoignable), hôte qui le porte et ce qui l'utilise (sondes, pont Home Assistant). Un broker injoignable met ses sondes en « inconnu ». Un broker utilisé ne peut pas être supprimé : retirer d'abord ce qui l'utilise. Sur la fiche de l'hôte, les rôles qu'il porte s'affichent ; supprimer un hôte porteur est refusé tant que ses rôles existent. Plusieurs brokers peuvent tourner sur un même hôte : l'unicité est par `(hôte, port)`.

## Alertes et statuts

Le domaine **Services** de l'hôte compte un élément par sonde. Une sonde hors service est une **alerte** (rouge) sur l'hôte et son site, avec la raison (« connexion refusée », « mot-clé absent de la réponse »…). Elle est comptée dans `alerts` et `critical` de [`/api/summary`](api.md#get-apisummary) et remonte sur le problème de l'hôte dans [Home Assistant](home-assistant.md#sondes-de-service).

## Home Assistant

La catégorie **Sondes** crée une entité par sonde, sur l'appareil de l'hôte ou, pour une sonde rattachée à une stack, sur l'appareil de cette stack. Voir [Home Assistant](home-assistant.md#sondes-de-service).

## API

Lecture des sondes d'un hôte ou d'un équipement : tous les profils. Tout le reste (écriture, test, brokers) : administrateurs seulement, car le hub ouvre des connexions vers ce qui est saisi.

| Route | Profil |
|---|---|
| `GET /api/hosts/:id/probes` | sondes d'un hôte, avec leur état en direct |
| `POST /api/hosts/:id/probes` | créer une sonde |
| `GET`, `POST /api/equipments/:id/probes` | la même chose pour un [équipement](equipements.md) (sans `stack`) |
| `PUT /api/probes/:id` | modifier une sonde (changer la cible remet son état à « inconnu ») |
| `DELETE /api/probes/:id` | supprimer une sonde |
| `POST /api/probes/test` | mesurer une cible sans rien enregistrer (`sourceHostId` : depuis un hôte) |
| `GET`, `PUT /api/settings/omada/vpn-probes/:id` | une sonde VPN avec son tunnel et ses candidats ; choisir sa source et sa cible (`{ sourceHostId, host }`, `""` : à choisir) |
| `POST /api/settings/omada/vpn-probes/:id/test` | mesurer un choix de source et de cible sans l'enregistrer |
| `GET /api/settings/mqtt-brokers` | brokers MQTT des sondes, avec état de connexion et nombre de sondes (le mot de passe n'est jamais renvoyé : `hasPassword`) |
| `GET /api/roles` | rôles du hub avec leur hôte porteur, leur état et ce qui les utilise (voir [API](api.md)) |
| `POST /api/roles` | déclarer un broker détecté par l'agent d'un hôte (`type: mqtt-broker`) |
| `PUT`, `DELETE /api/roles/:id` | modifier (ou réaffecter à un autre hôte), supprimer (refusé si une sonde ou le pont Home Assistant l'utilise) |
| `POST /api/roles/test` | tester la connexion d'un broker |

Corps d'une sonde :

```json
{
  "name": "Zigbee2MQTT",
  "stack": "zigbee",
  "target": { "type": "mqtt", "brokerId": "vouille", "topic": "zigbee2mqtt/bridge/state", "contains": "online" },
  "intervalSec": 60,
  "timeoutSec": 10,
  "retries": 1
}
```

`target` prend selon le type : `{ "type": "ping", "host" }`, `{ "type": "tcp", "host", "port" }`, `{ "type": "http", "url", "status", "keyword", "insecure" }`. Seuls `name` et `target` sont obligatoires. `sourceHostId` (ping seulement) : l'hôte dont l'agent mesure, absent pour le hub ; la sonde renvoie `runFrom` : `"hub"` ou `{ "hostId" }`. Les sondes VPN (`{ "type": "vpn", "roleId", "vpnId", "host" }`) sont créées par le hub et ne passent pas par ces routes.

## Limites actuelles

- Les sondes se rattachent aux **hôtes** et aux **équipements** (le modèle prévoit aussi les sites, non implémentés).
- Les sondes des équipements ne sont pas encore publiées dans Home Assistant.
- Seuls le **ping** et la sonde **VPN** peuvent être mesurés depuis un hôte avec agent (Linux) ; MQTT, TCP et HTTP partent toujours du hub.
- Pas d'import depuis Uptime Kuma : les sondes se saisissent à la main. Pas non plus de criticité par sonde ni par équipement (les groupes et tags de Kuma n'ont pas d'équivalent).
- Le hub doit joindre les cibles : un hub sur un site distant ne voit pas les services d'un autre site sans VPN.
