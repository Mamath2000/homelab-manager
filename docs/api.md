---
title: API
description: Accès à l'API du hub par clé d'API, endpoint /api/summary et liste de ses champs
sidebar_position: 5.5
---

# API

Le hub expose son API HTTP (celle de l'interface). Un service externe s'y authentifie avec une
[clé d'API](comptes.md#clés-dapi) plutôt qu'avec une session.

```bash
curl -H "Authorization: Bearer hm_…" http://HUB:PORT/api/summary
```

- Sans clé valable : `401`. Hors des droits du rôle du compte : `403`.
- Un compte `viewer` suffit pour la lecture ; il n'accède ni aux logs des conteneurs ni aux fichiers compose.

## `GET /api/summary`

Compteurs à plat du homelab, prévus pour un tableau de bord. Mêmes règles que l'appareil *Homelab Manager* de
[Home Assistant](home-assistant.md#homelab-manager) : les hôtes exclus de Home Assistant ne sont pas comptés, un hôte
itinérant n'est pas « hors ligne » quand il est absent. Tous les rôles peuvent le lire.

| Champ | Contenu |
|---|---|
| `hosts` | Nombre d'hôtes |
| `hostsOffline` | Hôtes dont l'agent est hors ligne |
| `updates` | Paquets à mettre à jour, tous hôtes |
| `security` | Dont mises à jour de sécurité |
| `hostsToUpdate` | Hôtes ayant au moins une mise à jour |
| `hostsToReboot` | Hôtes dont le redémarrage est requis |
| `hostsToClean` | Hôtes avec des paquets à nettoyer (`apt autoremove`) |
| `agentsOutdated` | Agents à mettre à jour |
| `stacks` | Stacks Docker suivies |
| `stacksToUpdate` | Stacks avec une image plus récente |
| `alerts` | Alertes en cours (agent, APT, Docker) |
| `critical` | Dont alertes critiques (agent hors ligne) |

:::note
Les sauvegardes ne sont pas comptées dans `alerts` : elles ont leur propre page et leur propre API (`/api/backups`).
:::

Exemple de réponse :

```json
{
  "hosts": 24, "hostsOffline": 1, "updates": 37, "security": 3,
  "hostsToUpdate": 9, "hostsToReboot": 2, "hostsToClean": 4, "agentsOutdated": 0,
  "stacks": 18, "stacksToUpdate": 2, "alerts": 6, "critical": 1
}
```

## `GET /api/status`

Statut en direct de chaque hôte, par domaine et par élément suivi (voir [Alertes et statuts](alertes.md)) : `domains` (identifiant, libellé, icône, dans l'ordre d'affichage) et `hosts` (par identifiant d'hôte : `level` ok / warn / alert et `domains`, chacun avec son `level` ok / warn / alert / unknown, ses `checks` et, si inconnu, la raison). Un domaine absent d'un hôte ne s'y applique pas. Tous les rôles peuvent le lire.

## Exemple : widget Homepage

Voir [Homepage](../../sites/vouille/homepage/index.md#widget-homelab-manager) : widget `customapi`, clé d'un compte
`viewer` sans mot de passe.
