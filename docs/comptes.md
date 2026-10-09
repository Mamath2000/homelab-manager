---
title: Comptes et rôles
description: Rôles admin / monitor / viewer, réinitialisation des mots de passe et compte de secours superadmin
sidebar_position: 4
---

# Comptes et rôles

## Rôles

| Rôle | Droits |
|---|---|
| `admin` | Tout, en lecture et en écriture, y compris la page **Comptes** |
| `monitor` | Tout sauf la gestion des comptes (hôtes, mises à jour, paramètres…) |
| `viewer` | Lecture seule ; ne voit ni **Paramètres** ni **Comptes** |

Les droits sont vérifiés par le hub sur chaque requête : l'interface ne fait que masquer ce qui n'est pas autorisé.
Chacun peut changer son propre mot de passe depuis l'icône clé de l'en-tête.

Les comptes existant avant l'introduction des rôles deviennent `admin`.

## Gestion des comptes

La page **Comptes** (réservée aux `admin`) permet de créer, renommer, changer le rôle et supprimer des comptes.
Un compte nouvellement créé n'a pas de mot de passe : l'utilisateur se connecte avec son nom **en laissant le mot
de passe vide**, puis choisit le sien.

**Réinitialiser le mot de passe** efface le mot de passe du compte et ferme ses sessions. À la connexion suivante,
l'utilisateur procède de la même façon : nom seul, puis nouveau mot de passe.

Garde-fous : on ne peut ni supprimer son propre compte, ni supprimer ou rétrograder le dernier `admin`.
Changer le rôle d'un compte le déconnecte.

## Premier compte

Il n'y a pas d'écran de création dans l'interface. Sur une installation neuve :

```bash
docker compose exec hub hm-admin create-admin <nom>
```

## Compte de secours `superadmin`

Si plus personne ne peut se connecter en admin, générer un mot de passe de secours :

```bash
docker compose exec hub hm-admin superadmin
```

- le mot de passe est **à usage unique** et valable **15 minutes** ; la session ouverte avec dure 15 minutes ;
- le compte `superadmin` peut uniquement **lister les comptes et réinitialiser leur mot de passe** : il n'a accès ni
  aux hôtes, ni aux paramètres, ni à la création / suppression de comptes ;
- relancer la commande invalide le mot de passe précédent et ferme une éventuelle session `superadmin` en cours.

:::note Sécurité
Pendant qu'un compte est en attente de mot de passe, n'importe qui pouvant joindre l'interface peut le définir en
connaissant le nom d'utilisateur. Le hub est prévu pour rester derrière un reverse proxy authentifié (Authelia…)
ou sur le LAN.
:::
