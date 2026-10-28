---
title: Sondes de service
description: Vérifier de l'extérieur qu'un service rend bien le service (MQTT, ping, TCP, HTTP) depuis le hub, sur un hôte ou un équipement, brokers MQTT, états, alertes, Home Assistant
sidebar_position: 3.7
---

# Sondes de service

Une **sonde** vérifie, depuis le hub, qu'un service est réellement rendu : un port qui répond, une page qui contient le bon texte, un appareil Zigbee ou ESPHome qui se déclare en ligne. C'est le complément de ce que l'agent rapporte de l'intérieur de l'hôte (Docker dit qu'un conteneur tourne, la sonde dit que le service répond).

Les sondes remplacent les moniteurs d'Uptime Kuma. Elles se rattachent à un **hôte**, éventuellement à l'une de ses **stacks Docker**, ou à un **[équipement](equipements.md)** (switch, passerelle, module domotique…), et alimentent le domaine **Services** des [alertes et statuts](alertes.md).

## Les quatre types

| Type | Ce qui est vérifié | Réglages |
|---|---|---|
| **MQTT** | le dernier message d'un topic d'un [broker MQTT](#brokers-mqtt) | topic exact (pas de joker `+` ni `#`) ; texte attendu dans le message, facultatif |
| **Ping** | l'adresse répond à un ping | nom ou adresse IP |
| **TCP** | le port accepte la connexion | nom ou adresse IP, port |
| **HTTP(S)** | l'URL répond comme attendu | code attendu (par défaut n'importe quel 2xx), mot-clé attendu dans la réponse, certificat non vérifié pour un certificat auto-signé |

- **MQTT, texte attendu** : le dernier message du topic doit le contenir. Un statut retenu (*retained*) reste valable tant qu'il n'est pas remplacé, comme la disponibilité Zigbee2MQTT (`online`) ou le dernier mot d'ESPHome. Sans texte attendu, un message doit être arrivé dans le délai maximal.
- **HTTP** : les redirections (jusqu'à 5) sont suivies, sauf quand le code attendu est justement celui de la redirection. Seul le début de la réponse est lu (1 Mo au plus), uniquement pour chercher le mot-clé.
- **Ping** nécessite la commande `ping` dans le conteneur du hub et l'autorisation d'envoyer de l'ICMP. Si ce n'est pas possible, la sonde est **inconnue** avec le message « ping non autorisé dans le conteneur du hub » (ou « commande ping absente du hub »), jamais en échec : le service n'est pas jugé.

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

1. **Type et nom**, et la stack de l'hôte à laquelle elle se rattache (facultatif).
2. **Cible** selon le type.
3. **Options** : intervalle, délai maximal, nouvelles tentatives.
4. **Test** : mesure immédiate, sans enregistrer. L'enregistrement ne demande pas de test réussi : une sonde peut être créée pour un service pas encore installé.

L'ajout et la modification se font sans confirmation ; la suppression en demande une. Tous les rôles voient les sondes d'un hôte ; seuls les **administrateurs** les ajoutent, les modifient, les testent et les suppriment, et gèrent les brokers.

## Sondes d'un équipement

La fiche d'un [équipement](equipements.md) a le même panneau **Sondes**, sans choix de stack. Une nouvelle sonde ping ou TCP reprend l'adresse IP de l'équipement, et changer cette adresse déplace les sondes ping et TCP qui visaient l'ancienne. La suppression d'un équipement supprime ses sondes.

:::info Stack supprimée
Quand une stack disparaît du rapport Docker de son hôte, ses sondes sont **supprimées** (elles ne feraient que passer en échec) et l'interface le signale par un message. Les sondes de l'hôte lui-même ne sont pas touchées. La suppression d'un hôte supprime toutes ses sondes.
:::

## Brokers MQTT

Les sondes MQTT écoutent leurs propres brokers, **distincts du broker du pont [Home Assistant](home-assistant.md)** (par exemple celui de Zigbee2MQTT et celui d'ESPHome d'un site). Ils se règlent dans **Paramètres › Sondes** (administrateurs) : nom, adresse (`mqtt://`, `mqtts://`, `ws://` ou `wss://`), compte facultatif. Comme pour Home Assistant, l'enregistrement exige un **test de connexion** réussi, et le mot de passe n'est jamais renvoyé par l'API.

La liste montre l'état de la connexion de chaque broker (connecté, connexion, injoignable) et le nombre de sondes qui l'utilisent. Un broker injoignable met ses sondes en « inconnu ». Un broker utilisé par des sondes ne peut pas être supprimé : supprimer ou déplacer ces sondes d'abord.

## Alertes et statuts

Le domaine **Services** de l'hôte compte un élément par sonde. Une sonde hors service est une **alerte** (rouge) sur l'hôte et son site, avec la raison (« connexion refusée », « mot-clé absent de la réponse »…). Elle est comptée dans `alerts` et `critical` de [`/api/summary`](api.md#get-apisummary) et remonte sur le problème de l'hôte dans [Home Assistant](home-assistant.md#sondes-de-service).

## Home Assistant

La catégorie **Sondes** crée une entité par sonde, sur l'appareil de l'hôte ou, pour une sonde rattachée à une stack, sur l'appareil de cette stack. Voir [Home Assistant](home-assistant.md#sondes-de-service).

## API

Lecture des sondes d'un hôte ou d'un équipement : tous les rôles. Tout le reste (écriture, test, brokers) : administrateurs seulement, car le hub ouvre des connexions vers ce qui est saisi.

| Route | Rôle |
|---|---|
| `GET /api/hosts/:id/probes` | sondes d'un hôte, avec leur état en direct |
| `POST /api/hosts/:id/probes` | créer une sonde |
| `GET`, `POST /api/equipments/:id/probes` | la même chose pour un [équipement](equipements.md) (sans `stack`) |
| `PUT /api/probes/:id` | modifier une sonde (changer la cible remet son état à « inconnu ») |
| `DELETE /api/probes/:id` | supprimer une sonde |
| `POST /api/probes/test` | mesurer une cible sans rien enregistrer |
| `GET`, `POST /api/settings/mqtt-brokers` | brokers MQTT des sondes (le mot de passe n'est jamais renvoyé : `hasPassword`) |
| `PUT`, `DELETE /api/settings/mqtt-brokers/:id` | modifier, supprimer (refusé si des sondes l'utilisent) |
| `POST /api/settings/mqtt-brokers/test` | tester la connexion d'un broker |

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

`target` prend selon le type : `{ "type": "ping", "host" }`, `{ "type": "tcp", "host", "port" }`, `{ "type": "http", "url", "status", "keyword", "insecure" }`. Seuls `name` et `target` sont obligatoires.

## Limites actuelles

- Les sondes se rattachent aux **hôtes** et aux **équipements** (le modèle prévoit aussi les sites, non implémentés).
- Les sondes des équipements ne sont pas encore publiées dans Home Assistant.
- Elles sont toutes lancées **depuis le hub** (le champ `runFrom` est dans le modèle pour d'autres exécutants plus tard, jamais l'hôte vérifié).
- Pas d'import depuis Uptime Kuma : les sondes se saisissent à la main.
- Le hub doit joindre les cibles : un hub sur un site distant ne voit pas les services d'un autre site sans VPN.
