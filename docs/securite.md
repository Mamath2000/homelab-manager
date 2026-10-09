---
title: Sécurité
description: Connexion chiffrée et authentifiée entre le hub et les agents, signature des binaires de l'agent
sidebar_position: 5
---

# Sécurité

Le hub expose deux ports :

| Port | Usage | Protection |
|---|---|---|
| `3000` | interface web et API REST | comptes et rôles, voir [Comptes et rôles](comptes.md) |
| `3443` | agents : script d'installation, binaires, enrôlement, connexion WebSocket | TLS, épinglage de la clé du hub, un certificat par agent |

Rien ne circule en clair entre le hub et les agents, et aucun secret réutilisable n'est transmis.

## Autorité de certification interne

Au premier démarrage, le hub crée sa propre autorité de certification (ECDSA P-256, valable 20 ans) et son certificat serveur (10 ans). Ils sont stockés dans MongoDB (collection `settings`, document `pki`). Il n'y a besoin ni d'une autorité publique ni d'un nom de domaine.

Les empreintes sont affichées dans **Paramètres > Agent** : adresse des agents, clé épinglée du serveur, empreinte SHA-256 de l'autorité.

## Installation : épinglage de la clé du hub

La commande d'installation contient l'empreinte de la clé publique du serveur :

```bash
curl -fsSLk --pinnedpubkey sha256//CLÉ https://IP_DU_HUB:3443/install.sh | sh -s -- CODE
```

- `--pinnedpubkey` : curl refuse la connexion si le serveur ne présente pas exactement cette clé, ce qui écarte un faux hub (usurpation d'IP, de DNS ou d'ARP). `-k` ne désactive que la vérification par une autorité publique et le contrôle du nom ; l'épinglage les remplace.
- Le script, reçu par ce canal épinglé, dépose le certificat de l'autorité du hub dans `/etc/homelab-agent/ca.pem`, puis télécharge le binaire de l'agent avec le même épinglage.
- curl est donc requis : wget ne sait pas épingler une clé.

Pour vérifier la clé à la main depuis un hôte :

```bash
openssl s_client -connect IP_DU_HUB:3443 </dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary | base64
```

Le résultat doit être identique à la clé épinglée affichée dans les paramètres.

## Enrôlement

- La commande d'installation contient un **code à usage unique, valable 24 h**. Le hub n'en garde que le hash. Une nouvelle commande annule la précédente.
- L'agent génère **sa clé privée sur l'hôte** (`/etc/homelab-agent/agent.key`, droits 600). Elle ne quitte jamais l'hôte : l'agent envoie au hub une demande de certificat (CSR) accompagnée du code.
- Le hub consomme le code, puis signe un **certificat client** : nom = identifiant de l'hôte, usage « authentification client » uniquement, valable 5 ans. Il retient l'empreinte de ce certificat sur l'hôte.
- Les codes invalides sont limités à 10 essais par IP toutes les 10 minutes.

## Connexion des agents (TLS mutuel)

- L'agent vérifie que le certificat du hub est signé par l'autorité de `ca.pem` et qu'il porte l'usage « serveur ». Le nom d'hôte n'est pas contrôlé : changer l'IP ou le nom du hub ne casse rien.
- Le hub exige un certificat client signé par son autorité, **et** dont l'empreinte est celle retenue pour l'hôte.
- Il n'y a ni jeton ni mot de passe : rien d'utile à intercepter.

## Révocation

- **Révoquer l'agent**, sur la fiche de l'hôte : la connexion est coupée immédiatement, le certificat et toute commande d'installation en attente sont refusés. L'hôte et son historique sont conservés ; pour le reconnecter, il faut une nouvelle commande d'installation.
- **Supprimer l'hôte** a le même effet sur l'agent.
- **Nouvelle commande d'installation** : l'agent en place continue de fonctionner jusqu'à ce que la nouvelle installation s'enrôle et remplace son certificat.

## Signature des binaires de l'agent

Les binaires de l'agent livrés dans une release sont **signés** (Ed25519) par la clé de release du projet, et chaque agent embarque la clé publique correspondante. À chaque mise à jour automatique, l'agent vérifie l'empreinte SHA-256 annoncée par le hub **et** la signature. Si la signature est absente ou invalide, il refuse la mise à jour et garde sa version.

Ainsi, même un hub compromis ne peut pas pousser sur les hôtes un agent qui ne sort pas du processus de release.

Les agents de développement (`make dev`, ou `make docker-build` sans clé de release) n'embarquent pas de clé : ils acceptent une mise à jour sur la seule empreinte et l'indiquent dans leurs logs (`development build`). **Paramètres > Agent** précise si les binaires distribués par le hub sont signés.

### Clé de release (mainteneur)

1. Une seule fois : `make release-key`. La clé privée est écrite dans `~/.config/homelab-manager/release.key` (droits 600, hors du dépôt ; autre chemin possible avec `RELEASE_KEY=…`). La clé publique est écrite dans `agent/release.pub`, **à commiter**.
2. `make docker-release` vérifie que la clé correspond à `agent/release.pub`, la passe au build comme secret BuildKit (elle n'est jamais copiée dans l'image), signe les binaires et embarque la clé publique dans les agents. Sans clé, la release est refusée.

:::warning Sauvegarder la clé de release
Si la clé est perdue ou remplacée, les agents installés refusent les binaires signés par la nouvelle clé. Il faut alors lancer une fois, sur chaque hôte, la commande de mise à jour manuelle (**Paramètres > Agent**) : elle passe par le canal épinglé et installe un agent qui embarque la nouvelle clé.
:::

## Ce qui est protégé, et contre quoi

| Menace | Protection |
|---|---|
| Écoute du réseau local | TLS sur tous les échanges avec les agents ; aucun secret réutilisable ne circule |
| Faux hub au moment de l'installation (usurpation d'IP, DNS, ARP) | clé du hub épinglée dans la commande d'installation |
| Faux hub après l'installation | l'agent n'accepte que l'autorité du hub, avec l'usage « serveur » |
| Agent qui tenterait de se faire passer pour le hub | les certificats d'agent n'ont que l'usage « client » |
| Commande d'installation récupérée après coup (historique shell, capture d'écran) | code à usage unique, valable 24 h |
| Faux agent | certificat client signé par le hub et dont l'empreinte est enregistrée pour l'hôte |
| Hôte compromis ou retiré du parc | « Révoquer l'agent » ou suppression de l'hôte |
| Binaire modifié pendant une mise à jour, hub compromis | signature de release vérifiée par l'agent |
| Vol de la base MongoDB | mots de passe hachés (scrypt), codes d'enrôlement hachés ; la clé de l'autorité y figure, la base est donc à protéger comme un secret |

## Limites

- Le hub reste le point de commande : un hub compromis peut lancer les actions prévues (mises à jour APT, nettoyage, redémarrage). Il ne peut ni exécuter de commande arbitraire ni installer un agent non signé.
- À l'installation initiale, tout vient du hub. La sécurité repose sur la commande copiée depuis l'interface, et donc sur l'accès à cette interface.
- Il n'y a pas de protection contre le retour à une version plus ancienne : un hub compromis peut redistribuer un ancien agent signé.
- L'autorité du hub vit dans MongoDB : si la base est perdue sans sauvegarde, le hub en crée une nouvelle au démarrage et tous les agents sont à réinstaller.
- Les certificats ne sont pas renouvelés automatiquement : 5 ans pour les agents (une réinstallation en délivre un nouveau), 10 ans pour le serveur, 20 ans pour l'autorité.
- Le port `3443` doit rester en accès direct, ou passer par un proxy TCP (*passthrough*). Un reverse proxy qui termine le TLS casserait l'épinglage et l'authentification des agents.
- L'interface (port `3000`) est servie en HTTP. Elle est prévue pour le réseau local ; pour du HTTPS, la placer derrière un reverse proxy (voir [Configuration](configuration.md)).
