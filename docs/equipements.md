---
title: Équipements
description: Suivre sans agent le matériel réseau, les passerelles et les modules domotiques (switch, AP, coordinateur, ESPHome…) avec des sondes, sources automatiques, alertes et tableau de bord
sidebar_position: 3.75
---

# Équipements

Un **équipement** est ce que Homelab Manager suit **sans agent** : gateway, switch, point d'accès, passerelle VPN, coordinateur Zigbee (SLZB), passerelle solaire (Envoy), interphone (VTO), module domotique ESPHome… Comme un hôte, il a :

- des **checks natifs**, remontés par sa **source** quand elle est automatique (un contrôleur Omada) : connecté, charge, tunnels VPN… ;
- des **[sondes](sondes.md)**, lancées depuis le hub : ping, port TCP, page HTTP, message MQTT (LWT ESPHome, disponibilité Zigbee2MQTT).

Les **modules domotiques stratégiques** ont leur place ici : ceux dont dépend le fonctionnement de la maison (routeur solaire, compteur général, téléinfo, commande du portail). Le critère est leur rôle, pas leur technologie : les capteurs ordinaires (températures…) restent dans Home Assistant.

## Fiche d'un équipement

| Champ | Contenu |
|---|---|
| **Nom** | unique sur son site |
| **Type** | Gateway, Switch, Point d'accès, Coordinateur, Passerelle, Module domotique, Autre |
| **Site** | un des sites de **Paramètres › Sites et tags**, facultatif |
| **Adresse IP** | IPv4 ou IPv6, facultative |
| **Équipement amont** | ce dont il dépend (switch, passerelle…), facultatif |
| **Source** | `manual` (saisi dans l'interface) ou `omada` (synchronisé) |

- **Ajouter un équipement** (menu **Équipements**) propose de **créer une sonde ping** sur l'adresse saisie (case cochée par défaut). Les autres sondes s'ajoutent ensuite depuis la fiche ; une nouvelle sonde ping ou TCP reprend l'adresse de l'équipement.
- **Changer l'adresse** d'un équipement déplace ses sondes ping et TCP qui visaient l'ancienne adresse, dont l'état repart de zéro.
- L'**équipement amont** est affiché sur la fiche (avec ceux qui en dépendent, « en aval »). Il ne masque **jamais** l'état d'une sonde : une sonde derrière un switch en panne reste en échec. Le hub refuse une boucle (un équipement en amont de lui-même).
- **Supprimer** un équipement supprime ses sondes et son historique d'alertes ; ceux qui en dépendaient n'ont plus d'amont. Retirer un site des paramètres retire ses équipements de ce site.

Tous les profils voient les équipements ; seuls les **administrateurs** les ajoutent, les modifient et les suppriment. L'ajout et la modification se font sans confirmation, la suppression en demande une.

## Sources automatiques

Un équipement d'une source automatique est créé et tenu à jour par la synchronisation de sa source, retrouvé par son identifiant dans la source (`externalId`, l'adresse MAC pour Omada). À chaque synchronisation, la source écrit ses **checks natifs** et leur date. Seul le **nom** se modifie à la main : type, site, adresse et équipement amont viennent de la source.

Pour un équipement Omada, la **présence** vient du contrôleur, la sonde vérifie le **service rendu** (interface, API).

### Omada

**Paramètres › Omada** présente en tête les **VPN site à site** de chaque contrôleur (tunnels IPsec, relus à chaque relevé) : réseaux locaux → distants, tunnel établi ou non selon le contrôleur, passerelle qui le porte et état de sa [sonde VPN](sondes.md#sondes-vpn). Une icône d'avertissement, avec son explication au survol, signale ce qui demande une intervention : passerelle à créer ou relier comme équipement, source et cible de la sonde à choisir (bouton **Configurer**). Une passerelle a un check natif « Tunnel _nom_ » par tunnel activé de son site (alerte sans associations de sécurité en entrée et en sortie).

## Alertes et statuts

Un équipement a au plus deux [domaines](alertes.md#domaines-et-éléments-suivis) :

| Domaine | Contenu | Quand |
|---|---|---|
| **Connexion** (`system`) | les checks natifs de la source ; inconnu si la source n'a pas répondu depuis 15 min | équipement d'une source automatique |
| **Services** (`services`) | une sonde = un élément (en échec : alerte), comme pour un hôte | au moins une sonde |

Un équipement manuel n'a donc que ses sondes. Son niveau est le pire de ses domaines ; sans sonde, il n'est **pas suivi** (gris). Le hub garde ses 30 derniers jours (collection `equipmentAlerts`) pour la frise de sa fiche, comme pour un hôte. Pas d'historique de mesures (voir [Sondes](sondes.md#états)).

## Où le voir

- **Équipements** : la liste par site, filtrable par type, source (dès qu'il y a plusieurs sources) et recherche (nom, IP). Chaque ligne montre l'état, le type, l'adresse, l'équipement amont et un carré par sonde.
- **Fiche équipement** : informations, frise des alertes sur 30 jours, état remonté par la source (équipement synchronisé) et panneau **Sondes**.
- **Tableau de bord** : le bloc **Équipements**, sous les sites, groupé par site. Une colonne par équipement, **un carré par sonde** (haut → bas, vert / rouge / gris) ; la connexion remontée par la source vient en premier. Un équipement sans sonde a un carré vide. Les équipements ne comptent pas dans la couleur des sites ni dans la frise « arrivée des alertes ».

:::info Pas encore dans Home Assistant
Les équipements et leurs sondes ne sont pas encore publiés dans Home Assistant.
:::

## API

Lecture : tous les profils. Écriture : administrateurs.

| Route | Profil |
|---|---|
| `GET /api/equipments` | équipements, chacun avec l'état de ses sondes (`probes` : `id`, `name`, `state`, `message`) |
| `GET /api/equipments/:id` | un équipement |
| `POST /api/equipments` | créer un équipement manuel ; `ping: true` crée aussi une sonde ping sur `ip` |
| `PATCH /api/equipments/:id` | modifier ; une chaîne vide efface `siteId`, `ip` ou `uplinkId` ; seul `name` pour un équipement synchronisé |
| `DELETE /api/equipments/:id` | supprimer, avec ses sondes et son historique |
| `GET /api/equipments/:id/alerts` | les jours de la frise des alertes |
| `GET`, `POST /api/equipments/:id/probes` | ses sondes, mêmes corps que celles d'un hôte (sans `stack`), voir [Sondes](sondes.md#api) |

Corps d'un équipement :

```json
{
  "name": "SLZB-06",
  "type": "coordinator",
  "siteId": "<id du site>",
  "ip": "192.168.20.40",
  "uplinkId": "<id de l'équipement amont>",
  "ping": true
}
```

`type` : `gateway`, `switch`, `ap`, `coordinator`, `bridge` (passerelle), `iot` (module domotique), `other`. Seuls `name` et `type` sont obligatoires. Le statut en direct des équipements est dans `equipments` de [`GET /api/status`](api.md#get-apistatus).
