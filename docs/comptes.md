---
title: Comptes et profils
description: Premier démarrage, profils admin / operator / viewer, mots de passe temporaires, comptes sans mot de passe, clés d'API et compte superadmin
sidebar_position: 5
---

# Comptes et profils

## Profils

| Profil | Droits |
|---|---|
| `admin` | Tout : hôtes (ajout, modification, suppression, commandes d'installation, révocation des agents), mises à jour, paramètres, comptes |
| `operator` | Voit tout et lance les actions : vérifications, mises à jour, nettoyages, redémarrages, verrouillage de session, mises à jour d'agents (pas l'extinction d'un hôte, réservée à `admin`). Ne gère ni les hôtes, ni les paramètres, ni les comptes |
| `viewer` | Lecture seule |

Les droits sont vérifiés par le hub sur chaque requête : l'interface ne fait que masquer ce qui n'est pas autorisé.
Chacun peut changer son propre mot de passe depuis l'icône clé de l'en-tête.

Les comptes existant avant l'introduction des profils deviennent `admin`.

## Premier démarrage

Sur une base vide, le hub crée le compte `superadmin` et écrit son mot de passe **à usage unique** dans ses logs
(`docker compose logs hub`). On se connecte avec, puis on crée les comptes depuis la page **Comptes**.

Ce mot de passe est valable 24 h et n'est invalidé qu'une fois qu'un compte a choisi son propre mot de passe (un échec de
connexion, par exemple un cookie refusé en HTTP, ne le consomme pas). Il n'est écrit qu'**une fois** : un `docker compose down` / `up` ou un redémarrage ne le change pas
(les logs le rappellent sans le réafficher, le hub n'en garde que le hash). Perdu ou expiré, en émettre un nouveau :

```bash
docker exec homelab-manager hm-admin superadmin
```

Un redémarrage n'en émet un nouveau que si le précédent a expiré.

## Nom et identifiant

Chaque compte a un **identifiant de connexion** et, en option, un **nom** (« Prénom Nom ») affiché dans la page
**Comptes** et dans l'en-tête. Les deux se modifient depuis la page **Comptes**.

## Mots de passe temporaires

Créer un compte ou **réinitialiser son mot de passe** (bouton « Réinitialiser » de la colonne *Mot de passe*, à
confirmer dans la ligne) génère un mot de passe temporaire, affiché **une seule fois** dans la ligne du compte avec un
bouton copier ; l'admin le transmet. À la connexion avec ce mot de passe, l'utilisateur doit en choisir un nouveau avant
d'accéder au hub. Une réinitialisation ferme aussi les sessions ouvertes du compte.

Garde-fous : on ne peut ni supprimer son propre compte, ni supprimer ou rétrograder le dernier `admin`.
Changer le profil d'un compte le déconnecte.

## Compte sans mot de passe

À la création, l'option **Aucun mot de passe** crée un compte réservé aux services : il **ne peut pas se connecter à
l'interface** (un avertissement le rappelle) et ne s'utilise qu'avec une [clé d'API](#clés-dapi). Ce compte n'a aucune clé
au départ : on les ajoute en le modifiant. « Réinitialiser » dans la colonne *Mot de passe* ne s'applique pas à un tel compte.

## Clés d'API

Une clé d'API permet à un service (Homepage, un script…) d'appeler l'[API du hub](api.md) sans session. Elle s'envoie
dans l'en-tête `Authorization: Bearer hm_…` et **a les droits du profil du compte** : pour un simple affichage, un compte
`viewer` sans mot de passe suffit.

Les clés se gèrent dans le dialogue **Modifier** d'un compte (page **Comptes**), section *Clés d'API* :

- **Plusieurs clés par compte**, chacune avec un nom (le service qui l'utilise), sa date de création et sa dernière
  utilisation : une clé se révoque sans toucher aux autres.
- **Générer** affiche la clé **une seule fois** avec un bouton copier ; seule son empreinte est conservée par le hub.
- **Révoquer** (à confirmer) refuse aussitôt le service qui l'utilise.
- Supprimer le compte supprime ses clés. Le compte `superadmin` ne peut pas en avoir.

Les clés ne passent jamais par le cookie de session. Une clé inconnue compte comme un échec de connexion (5 échecs par
minute et par adresse IP, puis refus temporaire).

## Compte `superadmin`

Le compte `superadmin` ne gère que les comptes : il peut **les lister, en créer et réinitialiser leurs mots de passe**,
sans accès aux hôtes ni aux paramètres. Son mot de passe est temporaire (invalidé dès qu'un compte a remplacé son mot de passe provisoire) et sa session dure 15 minutes.

En dehors du premier démarrage, il sert d'accès de secours si plus personne ne peut se connecter en admin :

```bash
docker compose exec hub hm-admin superadmin
```

Le mot de passe affiché est valable 15 minutes ; relancer la commande invalide le précédent et ferme une éventuelle
session `superadmin` en cours.

Dans l'application HAOS **Homelab Manager**, tu peux aussi activer **Réinitialiser le mot de passe superadmin au
démarrage**, enregistrer puis redémarrer l'application. Le nouveau mot de passe apparaît dans son journal et est valable
15 minutes. Désactive ensuite l'option pour éviter de régénérer le mot de passe au prochain redémarrage.
