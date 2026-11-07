---
title: Audit de sécurité
description: Bilan de l'audit de sécurité de novembre 2026, précautions à prendre et liste des corrections prévues
sidebar_position: 6.1
---

# Audit de sécurité

Homelab Manager a fait l'objet d'un audit de sécurité en **novembre 2026** (version 1.1.0) : revue du code du hub, de l'agent, de l'interface, du déploiement Docker et des dépendances. Cette page en donne le bilan, les précautions à prendre dès maintenant et la liste des corrections prévues.

Les détails techniques des points non encore corrigés ne sont volontairement pas publiés ici. Ils le seront une fois la correction livrée.

## En bref

Le socle est solide. La liaison avec les agents (TLS mutuel, clé du hub épinglée, enrôlement à usage unique, binaires signés) et la validation des paramètres par l'agent sont bien conçues : voir [Sécurité](securite.md).

Le point principal est le **modèle de menace** : **le hub est l'équivalent d'un accès root sur tout le parc.** Plusieurs fonctions légitimes, comme les sauvegardes, la standardisation ou l'installation d'agents depuis Proxmox VE, permettent à un hub ou à un compte administrateur compromis d'agir en root sur les hôtes, ou d'en lire les fichiers. Le hub, sa base MongoDB et les comptes administrateurs sont donc à protéger en conséquence.

## Ce qui est bien en place

- **Agents** : TLS mutuel, un certificat par agent, révocation immédiate, clé du hub épinglée dès l'installation.
- **Enrôlement** : code à usage unique, conservé haché, limité en tentatives. La clé privée de l'agent ne quitte jamais l'hôte.
- **Mises à jour de l'agent** : binaires signés (Ed25519) et vérifiés avant d'être remplacés.
- **Paramètres reçus par l'agent** : contrôlés strictement, sans passer par un shell. L'agent ne reçoit jamais un chemin de stack Docker.
- **Comptes** : mots de passe hachés (scrypt), sessions et clés d'API conservées hachées, cookie `HttpOnly` et `SameSite=Strict`, refus par défaut de ce qui n'est pas explicitement autorisé.
- **Jetons Proxmox** : moindre privilège (un jeton par hôte, limité à ses propres sauvegardes).
- **Secrets** : jamais renvoyés à l'interface.
- **Conteneur du hub** : tourne sans les droits root.

## Précautions à prendre dès maintenant

En attendant les corrections listées plus bas :

1. **Ne pas exposer l'interface sur Internet.** Sur le réseau local, la servir en **HTTPS** (reverse proxy, ou [port HTTPS natif](configuration.md#https-natif)), et ne publier le port `3000` que vers ce proxy (par exemple `127.0.0.1:3000:3000`). Donner l'adresse **exacte** du proxy à `TRUST_PROXY` (`TRUST_PROXY: "192.168.1.20"`) plutôt que `true` ou une plage : tout poste compris dans la plage déclarée peut choisir l'adresse IP que le hub lui attribue. Proxy sur une autre machine : le faire pointer sur le port HTTPS du hub.
2. **Protéger MongoDB.** Ne jamais publier son port, restreindre les droits du dossier `mongo-data` (`chmod 700`), activer le [compte MongoDB et la clé maître](securite.md#base-de-données-et-secrets), et garder la clé à part des sauvegardes de la base.
3. **Limiter les comptes Administrateur** au strict nécessaire, avec des mots de passe longs et uniques. Sur un hub antérieur à la correction de la standardisation, ne confier le profil **Opérateur** qu'à des personnes de confiance si elle est activée (`FEATURE_STANDARDISATION`).
4. **Verrouiller le broker MQTT** utilisé par le [pont Home Assistant](home-assistant.md). Les actions publiées (mises à jour des hôtes et des stacks) répondent à tout client autorisé à écrire sur leurs topics ([exemple d’ACL](home-assistant.md#sécurité-des-commandes)). Il faut donc :
   - interdire l'accès anonyme ;
   - réserver l'écriture sur `<topic>/+/+/set` au seul compte de Home Assistant ;
   - préférer `mqtts://`.
5. **Mettre à jour les agents** : la mise à jour pose la [politique locale](securite.md#politique-locale-de-lhôte) stricte sur chaque hôte qui n'en a pas.
6. **Tenir le hub à jour**, et ses agents avec lui.

## Liste des corrections prévues

Priorités : **P0** immédiat, **P1** sous un mois, **P2** dans le trimestre, **P3** ensuite.

| Priorité | Sujet | Type | État |
|---|---|---|---|
| P0 | Documenter le modèle de menace réel (le hub est l'équivalent de root sur le parc) | correction | ✅ fait (cette page, [Sécurité](securite.md#limites)) |
| P0 | Restreindre les droits du profil Opérateur sur la standardisation | correction | ✅ fait ([Standardisation](standardisation.md#rôles-et-sécurité)) |
| P0 | Commandes du pont Home Assistant : limitées aux mises à jour, journalisées, broker anonyme signalé | correction | ✅ fait ([Home Assistant](home-assistant.md#sécurité-des-commandes)) |
| P0 | Mettre à jour les dépendances qui ont des vulnérabilités connues | correction | ✅ fait (version 1.2.2) |
| P1 | Image du client de sauvegarde épinglée et vérifiée par l'agent | correction | ✅ fait ([Sécurité](securite.md#image-du-client-de-sauvegarde)) |
| P1 | HTTPS natif pour l'interface, cookie `Secure` automatique en HTTPS | correction | ✅ fait, HTTPS optionnel ([HTTPS natif](configuration.md#https-natif)) |
| P1 | Authentification MongoDB dans le déploiement de référence | correction | ✅ fait, optionnelle ([Sécurité](securite.md#base-de-données-et-secrets)) |
| P1 | Limitation des tentatives de connexion par compte, proxy de confiance restreint | correction | ✅ fait ([Comptes](comptes.md#tentatives-de-connexion)) |
| P1 | Fermer les flux temps réel d'une session révoquée, filtrer selon le profil | correction | à faire |
| P1 | Journal des actions clés (qui a fait quoi), dans l'application | évolution | ✅ fait ([Comptes](comptes.md#journal-des-actions)) |
| P1 | En-têtes de sécurité HTTP (CSP, anti-iframe, HSTS) | évolution | à faire |
| P1 | Chaîne de livraison : images épinglées, CI durcie, protection contre le retour à une version plus ancienne | évolution | à faire |
| P2 | Chiffrement des secrets stockés dans MongoDB (clé maître hors base) | évolution | ✅ fait, optionnel ([Sécurité](securite.md#base-de-données-et-secrets)) |
| P2 | Double authentification (TOTP, WebAuthn), sessions plus courtes, liste des sessions | évolution | à faire |
| P2 | Chiffrement côté client des sauvegardes PBS | évolution | à faire |
| P2 | Signature par l'administrateur des actions sensibles, vérifiée par l'agent | évolution | à faire |
| P2 | Politique locale par hôte, qui borne ce que le hub peut demander à l'agent | évolution | ✅ fait ([Sécurité](securite.md#politique-locale-de-lhôte)) |
| P2 | Déploiement durci de référence et page « Santé sécurité » | évolution | à faire |
| P3 | Durcissement systemd de l'agent, puis séparation de privilèges | évolution | à faire |
| P3 | Masquage des secrets dans les fichiers compose affichés, journaux filtrés selon le profil | correction | à faire |
| P3 | Vérification assistée des empreintes PBS, PVE et Omada | évolution | à faire |
| P3 | Code d'enrôlement hors de la ligne de commande, validité réduite | évolution | à faire |
| P3 | Renouvellement automatique des certificats et rotation de l'autorité | évolution | à faire |
| P3 | Vérification de la clé du dépôt Proxmox | correction | à faire |
| P3 | Version masquée aux visiteurs non connectés, noms de compte insensibles à la casse | correction | à faire |
| P3 | Droits par site ou groupe d'hôtes, clés d'API à portée réduite, SSO / OIDC | évolution | à faire |

Cette liste est mise à jour au fil des versions ; le [CHANGELOG](https://github.com/Mamath2000/homelab-manager/blob/main/CHANGELOG.md) indique la version qui apporte chaque correction.

## Signaler une vulnérabilité

Pour une faille de sécurité, ne pas ouvrir d'issue publique : utiliser le signalement privé de GitHub (**Security** › **Report a vulnerability**) sur le dépôt [Mamath2000/homelab-manager](https://github.com/Mamath2000/homelab-manager/security).
