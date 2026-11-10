---
title: Audit de sécurité
description: Bilan de l'audit de sécurité de novembre 2026, constats, corrections apportées et bonnes pratiques
sidebar_position: 6.1
---

# Audit de sécurité

Homelab Manager a fait l'objet d'un audit de sécurité le **6 novembre 2026** (version 1.1.0) : revue du code du hub, de l'agent, de l'interface, du déploiement Docker et des dépendances. Cette page en donne le bilan, le détail des constats et de leur correction, et les bonnes pratiques qui restent valables.

**Tous les constats sont traités** : corrigés, ou non retenus avec leur raison. Les corrections sont livrées en **1.2.2** pour les plus urgentes, et en **1.2.36** pour les suivantes. Un hub antérieur reste exposé aux points corrigés après lui : le mettre à jour, puis ses agents.

## En bref

Le socle est solide. La liaison avec les agents (TLS mutuel, clé du hub épinglée, enrôlement à usage unique, binaires signés) et la validation des paramètres par l'agent sont bien conçues : voir [Sécurité](securite.md).

Le point principal est le **modèle de menace** : **le hub est l'équivalent d'un accès root sur tout le parc**, et c'est assumé. Plusieurs fonctions légitimes, comme les sauvegardes, la standardisation ou l'installation d'agents depuis Proxmox VE, permettent à un hub ou à un compte administrateur compromis d'agir en root sur les hôtes, ou d'en lire les fichiers. Le hub, sa base MongoDB et les comptes administrateurs sont donc protégés en conséquence : passkey des admins, passkey redemandée avant les actions sensibles, sessions courtes, journal des actions, base chiffrée, [déploiement durci](securite.md#déploiement-durci). La [politique locale](securite.md#politique-locale-de-lhôte) de chaque hôte borne une partie de ce que le hub peut demander.

## Ce qui est bien en place

- **Agents** : TLS mutuel, un certificat par agent, [renouvelé automatiquement](securite.md#renouvellement-des-certificats), révocation immédiate, clé du hub épinglée dès l'installation.
- **Enrôlement** : code à usage unique, conservé haché, limité en tentatives, valable 1 h, passé hors de la ligne de commande. La clé privée de l'agent ne quitte jamais l'hôte.
- **Mises à jour de l'agent** : binaires signés (Ed25519) et vérifiés avant d'être remplacés, refus d'une version plus ancienne que le plancher.
- **Paramètres reçus par l'agent** : contrôlés strictement, sans passer par un shell. L'agent ne reçoit jamais un chemin de stack Docker.
- **Comptes** : mots de passe hachés (scrypt), sessions et clés d'API conservées hachées, cookie `HttpOnly` et `SameSite=Strict`, refus par défaut de ce qui n'est pas explicitement autorisé.
- **Jetons Proxmox** : moindre privilège (un jeton par hôte, limité à ses propres sauvegardes).
- **Secrets** : jamais renvoyés à l'interface, chiffrés en base avec la clé maître.
- **Conteneur du hub** : tourne sans les droits root.

## Bonnes pratiques

1. **Ne pas exposer l'interface sur Internet.** Sur le réseau local, la servir en **HTTPS** (reverse proxy, ou [port HTTPS natif](configuration.md#https-natif)), et ne publier le port `3000` que vers ce proxy (par exemple `127.0.0.1:3000:3000`). Donner l'adresse **exacte** du proxy à `TRUST_PROXY` (`TRUST_PROXY: "192.168.1.20"`) plutôt que `true` ou une plage : tout poste compris dans la plage déclarée peut choisir l'adresse IP que le hub lui attribue. Proxy sur une autre machine : le faire pointer sur le port HTTPS du hub.
2. **Protéger MongoDB.** Ne jamais publier son port, restreindre les droits du dossier `mongo-data` (`chmod 700`), activer le [compte MongoDB et la clé maître](securite.md#base-de-données-et-secrets), et garder la clé à part des sauvegardes de la base. Le [déploiement durci](securite.md#déploiement-durci) les rend obligatoires.
3. **Limiter les comptes Administrateur** au strict nécessaire, avec une [passkey](comptes.md#passkeys) (`MFA_REQUIRED=true`) et un mot de passe long et unique.
4. **Verrouiller le broker MQTT** utilisé par le [pont Home Assistant](home-assistant.md). Les actions publiées (mises à jour des hôtes et des stacks) répondent à tout client autorisé à écrire sur leurs topics ([exemple d’ACL](home-assistant.md#sécurité-des-commandes)). Il faut donc :
   - interdire l'accès anonyme ;
   - réserver l'écriture sur `<topic>/+/+/set` au seul compte de Home Assistant ;
   - préférer `mqtts://`.
5. **Tenir le hub à jour, et ses agents avec lui** : plusieurs protections (politique locale, version minimum, renouvellement du certificat) ne s'appliquent qu'aux agents à jour. **Paramètres › Sécurité** liste les agents en retard.

## Constats et corrections

Priorités de l'audit : **P0** immédiat, **P1** sous un mois, **P2** dans le trimestre, **P3** ensuite.

| Constat | Priorité | Constat de l'audit | Risque | Correction | Version |
|---|---|---|---|---|---|
| F-01 | P0 | La doc affirmait qu'un hub compromis ne pouvait pas exécuter de commande sur les hôtes, alors que l'image du client de sauvegarde, l'installation d'agents depuis Proxmox VE, la standardisation et le choix des répertoires sauvegardés le lui permettent | root sur tous les hôtes et exfiltration de leurs données après compromission du hub, d'une session admin ou de la base | modèle « hub = root » documenté ([Limites](securite.md#limites)) ; [politique locale](securite.md#politique-locale-de-lhôte) par hôte ; [image du client](securite.md#image-du-client-de-sauvegarde) épinglée dans l'agent ; installation depuis Proxmox VE par le binaire signé du nœud, sans script du hub | 1.2.2 |
| F-02 | P0 | Un opérateur pouvait écrire les valeurs de standardisation d'un hôte (clés SSH de root…) puis les appliquer, même pour une option désactivée par l'admin | un opérateur ou sa clé d'API devient root sur tous les hôtes | valeurs de standardisation réservées aux admins ; l'opérateur vérifie et applique ([Standardisation](standardisation.md#rôles-et-sécurité)) | 1.2.2 |
| F-03 | P0 | Le pont Home Assistant exécutait reboot, arrêt de stack, `apt upgrade` ou `autoremove` sur toute publication `PRESS` dans `<topic>/+/+/set` | tout client du broker pilote le parc sans compte ni trace | commandes limitées aux mises à jour, journalisées, broker anonyme signalé ([Home Assistant](home-assistant.md#sécurité-des-commandes)) | 1.2.2 |
| F-04 | P1 | Clés privées de l'autorité et du certificat serveur, jetons PBS / PVE, mots de passe MQTT et secret Omada en clair dans MongoDB, sans authentification | une lecture de la base livre tout, dont de quoi se faire passer pour le hub auprès des agents | compte MongoDB et clé maître (AES-256-GCM, hors base) ; obligatoires dans le déploiement durci ([Base de données et secrets](securite.md#base-de-données-et-secrets)) | 1.2.2 |
| F-05 | P1 | Interface et API en HTTP sur toutes les interfaces, cookie non `Secure` par défaut | cookie admin, mots de passe et clés d'API interceptables sur le LAN | cookie `Secure` automatique en HTTPS, `TRUST_PROXY` restreint à une adresse ; [HTTPS natif](configuration.md#https-natif), bandeau en HTTP, proxy non déclaré refusé | 1.2.2, 1.2.36 |
| F-06 | P1 | Aucune trace de qui a fait quoi (comptes, clés, réglages, révocations, connexions) ; les jobs ne gardaient que leur déclencheur | abus d'un compte ou d'une clé d'API indétectable | [journal des actions](comptes.md#journal-des-actions), non modifiable depuis le hub, conservé un an | 1.2.36 |
| F-07 | P2 | Mot de passe de 8 caractères sans autre contrôle, session de 30 jours, pas de second facteur ni de liste des sessions | un seul mot de passe protège l'équivalent de root sur le parc | [passkeys](comptes.md#passkeys) (obligatoires pour les admins avec `MFA_REQUIRED`), passkey redemandée avant les actions sensibles, 12 caractères et liste de mots de passe divulgués, [sessions](comptes.md#sessions) de 12 h d'inactivité et 7 jours au plus | 1.2.36 |
| F-08 | P1 | Limitation des tentatives en mémoire, par IP seulement, non bornée ; `X-Forwarded-For` cru de toute source ; temps de réponse différent si le compte existe | bruteforce en changeant d'IP ou en falsifiant l'en-tête, comptes devinables | [tentatives limitées](comptes.md#tentatives-de-connexion) par compte et par adresse, mémoire bornée, proxy de confiance restreint, coût identique que le compte existe ou non | 1.2.36 |
| F-09 | P1 | Flux temps réel `/api/events` authentifié à l'ouverture seulement | un compte supprimé, rétrogradé ou déconnecté continue de recevoir l'état du parc | [flux fermés](comptes.md#flux-temps-réel) à la révocation d'une session ou d'une clé, revalidés toutes les 60 s ; pas de filtrage par profil (l'opérateur et le lecteur lisent les mêmes données en REST) | 1.2.36 |
| F-10 | P1 | Aucun en-tête de sécurité HTTP | aucune défense en profondeur contre une injection de script | CSP stricte, anti-iframe, `nosniff`, `no-referrer`, HSTS en HTTPS ([En-têtes](securite.md#en-têtes-de-sécurité-http)) | 1.2.36 |
| F-11 | P1 | Image du client de sauvegarde en `:latest`, hub en `:latest`, actions CI non épinglées, aucun scan, version absente de la signature des binaires | un compte Docker Hub compromis touche tous les hôtes ; un hub compromis peut redistribuer un ancien agent signé | image du client épinglée (1.2.2) ; images par empreinte dans le déploiement durci, actions épinglées par SHA, `npm audit`, `govulncheck`, Grype, gitleaks, Dependabot, SBOM et provenance, [version minimum](securite.md#version-minimum-anti-retour-arrière) de l'agent ; signature cosign des images non retenue | 1.2.2, 1.2.36 |
| F-12 | P2 | Sauvegardes PBS non chiffrées côté client | sauvegardes lisibles par qui administre le PBS ou en vole les disques | **non retenu** : les deux PBS sont à nous, sur deux sites, et le chiffrement compliquerait fortement le montage et la restauration | — |
| F-13 | P0 | Dépendances vulnérables (`smol-toml`, `fastify`, `glob`, `minimatch`…), agent non analysé | déni de service du hub, failles connues exposées | dépendances à jour, `npm audit` propre, `govulncheck` sur l'agent, contrôle en CI | 1.2.2 |
| F-14 | P3 | Unité systemd de l'agent sans restriction | une faille de l'agent donne un root sans limite | **non retenu**, comme la séparation de privilèges (E-10) : l'agent garde l'accès à Docker et à systemd, donc le confinement se contourne, pour un risque de régression réel (apt, LXC) | — |
| F-15 | P3 | Seuls les `.env` étaient masqués dans les fichiers compose affichés ; le lecteur lisait la sortie complète des jobs | mots de passe applicatifs lisibles par des comptes non admin | fichiers compose réservés aux admins, sortie des jobs non lisible par le lecteur ([Docker](docker.md#logs-et-fichiers-compose)) | 1.2.36 |
| F-16 | P3 | Empreinte d'un PBS, d'un Proxmox VE ou d'un contrôleur Omada épinglée au premier contact sans comparaison | une interception au moment du réglage fait épingler le certificat d'un attaquant, qui reçoit ensuite les jetons | empreinte lue sur l'hôte par son agent et comparée, sinon invite à la vérifier ([Sauvegardes](sauvegardes.md#proxmox-backup-server), [Omada](roles.md#empreinte-du-contrôleur-omada)) | 1.2.36 |
| F-17 | P3 | Code d'enrôlement en argument de la commande (historique, `ps`), valable 24 h | un code récupéré enrôle un faux agent à la place de l'hôte | code passé par `HLM_ENROLL_CODE`, valable 1 h, date et adresse d'utilisation sur la fiche ([Enrôlement](securite.md#enrôlement)) | 1.2.36 |
| F-18 | P3 | Certificats de l'autorité (20 ans), du serveur (10 ans) et des agents (5 ans) jamais renouvelés | après une fuite de la base, des certificats valables des années | [renouvellement automatique](securite.md#renouvellement-des-certificats) : 1 an pour les agents, 2 ans pour le serveur ; rotation de l'autorité non retenue (trop lourde pour le gain) | 1.2.36 |
| F-19 | P3 | Clé du dépôt Proxmox installée sans vérification | une clé substituée ferait accepter les paquets d'un faux dépôt | SHA-512 des clés embarqué dans l'agent, clé différente refusée | 1.2.36 |
| F-20 | P3 | Version exacte du hub renvoyée par `/api/health`, route publique | aide à viser une version vulnérable | version retirée de la route publique | 1.2.36 |
| F-21 | P3 | Noms de compte uniques en tenant compte de la casse (`Admin` et `admin`) | confusion ou usurpation visuelle d'un compte | [identifiants](comptes.md#nom-et-identifiant) en minuscules, doublons existants signalés | 1.2.36 |

### Évolutions proposées par l'audit

| Évolution | Priorité | Proposition | Suite donnée |
|---|---|---|---|
| E-1 | P2 | Signature par l'administrateur des actions sensibles, vérifiée par l'agent | sans objet : le hub est assumé équivalent root ([Limites](securite.md#limites)) ; les chemins sensibles restent bloqués par la politique locale |
| E-2 | P2 | Politique locale par hôte, qui borne ce que le hub peut demander | ✅ fait en 1.2.2 ([Politique locale](securite.md#politique-locale-de-lhôte)) |
| E-3 | P3 | Droits par site ou groupe d'hôtes, clés d'API à portée réduite | non retenu : les profils globaux suffisent |
| E-4 | P3 | Authentification SSO / OIDC | non retenu |
| E-5 | — | Rotation planifiable des jetons PBS et Proxmox VE | rattachée à F-04 ; jetons PBS des hôtes régénérables à la demande depuis la 1.2.2 ([Régénérer le jeton d'un hôte](sauvegardes.md#régénérer-le-jeton-dun-hôte)) |
| E-7 | P1 | Chaîne de livraison durcie | rattachée à F-11 |
| E-8 | P2 | Chiffrement côté client des sauvegardes | rattachée à F-12, non retenue |
| E-9 | P2 | Déploiement durci de référence et page « Santé sécurité » | ✅ fait en 1.2.36 ([Déploiement durci](securite.md#déploiement-durci)) |
| E-10 | P3 | Séparation de privilèges dans l'agent | non retenu, voir F-14 |

Le [CHANGELOG](https://github.com/Mamath2000/homelab-manager/blob/main/CHANGELOG.md) détaille chaque correction.

## Signaler une vulnérabilité

Pour une faille de sécurité, ne pas ouvrir d'issue publique : utiliser le signalement privé de GitHub (**Security** › **Report a vulnerability**) sur le dépôt [Mamath2000/homelab-manager](https://github.com/Mamath2000/homelab-manager/security).
