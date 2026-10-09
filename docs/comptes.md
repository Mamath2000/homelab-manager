---
title: Comptes et rôles
description: Premier démarrage, rôles admin / operator / viewer, mots de passe temporaires et compte superadmin
sidebar_position: 5
---

# Comptes et rôles

## Rôles

| Rôle | Droits |
|---|---|
| `admin` | Tout : hôtes (ajout, modification, suppression, commandes d'installation, révocation des agents), mises à jour, paramètres, comptes |
| `operator` | Voit tout et lance les actions : vérifications, mises à jour, nettoyages, redémarrages, mises à jour d'agents. Ne gère ni les hôtes, ni les paramètres, ni les comptes |
| `viewer` | Lecture seule |

Les droits sont vérifiés par le hub sur chaque requête : l'interface ne fait que masquer ce qui n'est pas autorisé.
Chacun peut changer son propre mot de passe depuis l'icône clé de l'en-tête.

Les comptes existant avant l'introduction des rôles deviennent `admin`.

## Premier démarrage

Sur une base vide, le hub crée le compte `superadmin` et écrit son mot de passe **à usage unique** dans ses logs
(`docker compose logs hub`). On se connecte avec, puis on crée les comptes depuis la page **Comptes**.

Ce mot de passe est valable 24 h et redonné à chaque redémarrage du hub tant qu'aucun compte n'existe
(`docker compose restart hub` s'il a été perdu).

## Nom et identifiant

Chaque compte a un **identifiant de connexion** et, en option, un **nom** (« Prénom Nom ») affiché dans la page
**Comptes** et dans l'en-tête. Les deux se modifient depuis la page **Comptes**.

## Mots de passe temporaires

Créer un compte ou **réinitialiser son mot de passe** (bouton « Réinitialiser » de la colonne *Mot de passe*, à
confirmer dans la ligne) génère un mot de passe temporaire, affiché **une seule fois** dans la ligne du compte avec un
bouton copier ; l'admin le transmet. À la connexion avec ce mot de passe, l'utilisateur doit en choisir un nouveau avant
d'accéder au hub. Une réinitialisation ferme aussi les sessions ouvertes du compte.

Garde-fous : on ne peut ni supprimer son propre compte, ni supprimer ou rétrograder le dernier `admin`.
Changer le rôle d'un compte le déconnecte.

## Compte `superadmin`

Le compte `superadmin` ne gère que les comptes : il peut **les lister, en créer et réinitialiser leurs mots de passe**,
sans accès aux hôtes ni aux paramètres. Son mot de passe est à usage unique et sa session dure 15 minutes.

En dehors du premier démarrage, il sert d'accès de secours si plus personne ne peut se connecter en admin :

```bash
docker compose exec hub hm-admin superadmin
```

Le mot de passe affiché est valable 15 minutes ; relancer la commande invalide le précédent et ferme une éventuelle
session `superadmin` en cours.
