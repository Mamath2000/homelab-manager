---
title: Alertes et statuts
description: Comment Homelab Manager calcule l'état d'un hôte et d'un site (domaines, éléments suivis, trois états, hôte hors ligne ou itinérant) et ce que montrent le tableau de bord et la fiche hôte
sidebar_position: 3.9
---

# Alertes et statuts

Le cœur de Homelab Manager : un seul calcul, fait par le hub, donne l'état de chaque hôte. Le tableau de bord, la fiche hôte, l'historique des 30 jours et la couleur d'un site en sont tous issus, et restent donc cohérents entre eux.

## Domaines et éléments suivis

- Un **domaine** est une source d'information sur l'hôte. Les domaines sont, dans l'ordre d'affichage :

| Domaine | Ce qu'il suit | S'applique à l'hôte si |
|---|---|---|
| **Connexion** (`system`) | l'agent est joignable | toujours |
| **Mises à jour** (`apt`) | sécurité, redémarrage, paquets, fraîcheur des listes | l'hôte a rapporté APT |
| **Docker** (`docker`) | une stack gérée = un élément (problème, image à mettre à jour) | l'hôte a rapporté Docker |
| **Sauvegardes** (`backup`) | un groupe de sauvegarde = un élément | au moins une sauvegarde est rattachée à l'hôte |
| **Copie externe** (`offsite`) | la copie vers le PBS de secours, un groupe copié = un élément | au moins une copie déportée est activée |
| **Onduleur** (`ups`) | les problèmes remontés par NUT | l'hôte a un onduleur |

- Un **élément suivi** est ce qui porte un état : une sauvegarde précise, une stack, un problème d'onduleur. Chaque élément est ok, avertissement ou alerte, avec la raison quand il ne l'est pas.

## Agrégation

```
élément → domaine → hôte → site
```

À chaque étage, c'est le **pire** niveau qui l'emporte (ok < avertissement < alerte). Un hôte est donc le pire de ses domaines, un site le pire de ses hôtes.

## Trois états par domaine

Pour chaque couple hôte × domaine :

| État | Sens | Rendu |
|---|---|---|
| **Non applicable** | l'hôte ne fournit pas ce domaine (pas de Docker, pas d'onduleur, pas de copie externe) | transparent ; pas de ligne dans la frise de la fiche |
| **Inconnu** | le domaine s'applique, mais on ne peut pas le lire maintenant | gris ; **ne compte jamais** dans le pire niveau |
| **Connu** | une lecture existe | vert, orange ou rouge |

### Hôte hors ligne

- **Connexion** : orange, rouge si l'hôte est marqué critique.
- **Mises à jour, Docker, Onduleur** : gris s'il en a (le dernier rapport ne dit rien d'aujourd'hui), transparent sinon.
- **Sauvegardes, Copie externe** : leur vraie valeur, car elles se lisent côté PBS et ne dépendent pas de l'hôte.

### Hôte itinérant absent

Être hors ligne est son état normal :

- **Connexion** : grise (« Absent (itinérant) »), jamais une alerte.
- **Sauvegardes, Copie externe** : un retard n'est pas une alerte tant qu'il est absent (il ne peut pas sauvegarder) ; un échec ou une disparition du PBS reste une alerte.
- Les autres domaines sont gris comme pour tout hôte hors ligne.

Un agent jamais connecté est en attente : **Connexion** grise.

## Copie externe

Activer la copie déportée d'une sauvegarde ajoute la ligne **Copie externe** à l'hôte, sans autre réglage :

| Situation | Niveau |
|---|---|
| activée, aucune copie encore faite sur le PBS de secours (donnée pas encore sécurisée) | avertissement |
| copie en échec | alerte |
| copie en retard | avertissement |
| copiée, ou nouveau snapshot en attente de la prochaine série | OK |

## Où le voir

- **Fiche hôte** : la frise des 30 jours a une ligne par domaine que l'hôte fournit ; le jour sélectionné détaille les raisons. Aujourd'hui reprend l'état en direct, les jours passés l'historique enregistré par le hub.
- **Tableau de bord, vue par site** : une colonne par hôte et un carré par domaine de l'ensemble des hôtes du site (haut → bas dans l'ordre du tableau ci-dessus). Un domaine que l'hôte ne fournit pas reste transparent. Le point du site est le pire de ses hôtes ; les jauges comptent les hôtes par état, domaine par domaine.
- **Tableau de bord, arrivée des alertes** : une ligne par site, le pire niveau du jour sur ses hôtes et ses domaines ; le filtre liste les domaines présents. Le jour courant reprend l'état en direct, donc la frise est cohérente avec la couleur du site.

## Historique

Le hub enregistre l'état de chaque domaine et de chaque jour (le dernier relevé du jour, avec ses raisons), conservé un peu plus que les 30 jours affichés. Ce qui est **inconnu** n'est pas enregistré : le jour reste « rien de relevé » pour ce domaine. Une tâche en échec compte immédiatement dans le domaine concerné.

## Ajouter un élément à suivre

Côté hub, un domaine est un *fournisseur* déclaré dans le registre (`hub/src/monitoring.ts`) : il renvoie « non applicable », « inconnu » ou la liste de ses éléments. L'interface n'a pas de liste de domaines : frises, tuiles, jauges, filtre et couleur des sites lisent le registre via `GET /api/status`. Un nouveau domaine (disque SMART, CPU…) apparaît donc partout sans retoucher l'interface.

## Limites actuelles

L'[intégration Home Assistant](home-assistant.md) et le compteur [`/api/summary`](api.md) ont leurs propres règles d'alerte et ne lisent pas encore ce calcul (par exemple la copie externe n'y est pas comptée).
