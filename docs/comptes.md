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
| `operator` | Voit tout et lance les actions : vérifications, mises à jour, nettoyages, redémarrages, verrouillage de session, mises à jour d'agents, vérification et application de la standardisation avec les valeurs réglées par un admin (pas l'extinction d'un hôte, ni la modification des choix de standardisation, réservées à `admin`). Ne gère ni les hôtes, ni les paramètres, ni les comptes |
| `viewer` | Lecture seule |

Les droits sont vérifiés par le hub sur chaque requête : l'interface ne fait que masquer ce qui n'est pas autorisé.
## Fenêtre d'un compte

La même fenêtre sert à chacun pour son propre compte (**Mon compte**, en cliquant sur son nom en bas du menu, à côté de
**Déconnexion**) et à un admin pour les autres (**Modifier** dans la page **Comptes**). Ses onglets agissent chacun de
leur côté, avec leur propre bouton ; ce que l'on ne peut pas changer est affiché en lecture seule :

| Onglet | Mon compte | Compte d'un autre (admin) |
|---|---|---|
| Compte | nom, identifiant, profil : modifiables par un admin, en lecture seule sinon | nom, identifiant, profil |
| Mot de passe | changement (mot de passe actuel, nouveau) | état, réinitialisation (mot de passe temporaire affiché une fois) |
| Double authentification | état, passkeys, ajout, suppression, désactivation | état, passkeys, désactivation (passkey perdue) |
| Sessions | navigateurs connectés, fermeture d'une session | idem, et fermeture de toutes |
| Clés d'API | admins seulement | création, révocation |


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

L'identifiant est **en minuscules** : il est converti à la création, au renommage et à la connexion (`Admin` et `admin`
désignent le même compte, deux comptes ne peuvent plus ne différer que par la casse). Au démarrage, le hub passe en
minuscules les identifiants des comptes plus anciens et garde l'ancienne écriture comme nom s'il n'y en avait pas. Si
deux comptes existants ne diffèrent que par la casse, ils sont laissés tels quels et signalés dans les journaux du hub
(`differ only by case`) : à renommer à la main.

## Mots de passe temporaires

Créer un compte ou **réinitialiser son mot de passe** (bouton « Réinitialiser » de la colonne *Mot de passe*, à
confirmer dans la ligne) génère un mot de passe temporaire, affiché **une seule fois** dans la ligne du compte avec un
bouton copier ; l'admin le transmet. À la connexion avec ce mot de passe, l'utilisateur doit en choisir un nouveau avant
d'accéder au hub. Une réinitialisation ferme aussi les sessions ouvertes du compte.

## Choix du mot de passe

Un mot de passe choisi par l'utilisateur (changement, ou remplacement d'un mot de passe temporaire) doit :

- faire au moins **12 caractères** ;
- ne pas figurer dans la liste des mots de passe divulgués embarquée dans le hub (environ 73 000 mots de passe de 12
  caractères ou plus, tirés des listes publiques de [SecLists](https://github.com/danielmiessler/SecLists), comparés sans
  tenir compte de la casse) ;
- être différent de l'identifiant du compte.

Ces règles ne s'appliquent qu'aux **nouveaux** mots de passe : ceux déjà en place restent valables. Changer son mot de
passe ferme ses autres sessions.

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

Les clés ne passent jamais par le cookie de session. Les clés inconnues ont leur propre compteur, distinct de celui des
connexions (10 échecs par adresse IP, puis refus d'une minute qui double à chaque nouvel échec, 15 min au plus) : un
script qui garde une clé révoquée ne bloque pas la connexion à l'interface.

## Tentatives de connexion

Le hub compte les **échecs** de connexion (pas les connexions réussies) de trois façons :

| Compteur | Seuil | Effet |
|---|---|---|
| un compte depuis une adresse IP | 5 échecs | refus de 2 s, qui double à chaque nouvel échec (15 min au plus) ; seul ce couple est bloqué |
| une adresse IP, tous comptes confondus | 20 échecs en 15 min | refus de 15 min pour cette adresse |
| un compte, toutes adresses confondues | 50 échecs en 1 h | ralentissement (2 s, doublé, 5 min au plus) et avertissement dans les journaux |

Un refus répond `429` avec l'en-tête `Retry-After`, et l'écran de connexion indique le délai. Le dernier compteur ne
fait que ralentir : un tiers qui tape de faux mots de passe ne peut pas bloquer durablement le compte d'un admin. Une
adresse IPv6 compte pour son préfixe `/64`. Les compteurs sont en mémoire : **redémarrer le hub les remet à zéro**.

La réponse est la même, et prend le même temps, que le compte existe ou non, qu'il soit sans mot de passe ou que le
mot de passe `superadmin` ait expiré. Derrière un reverse proxy, l'adresse vue est celle que donne le proxy : déclarez
son adresse exacte dans [`TRUST_PROXY`](configuration.md#variables-denvironnement), pas une plage.

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

## Passkeys

Une **passkey** (WebAuthn) sert de second facteur : elle est demandée **après le mot de passe**, à chaque connexion des
comptes qui en ont une. Elle se crée avec le navigateur, le système ou un gestionnaire de mots de passe (Bitwarden,
1Password…) ; une clé matérielle (YubiKey…) convient aussi. Sa clé privée ne quitte jamais l'appareil ou le
gestionnaire : le hub ne garde que la clé publique, et une passkey volée en base ne permet pas de se connecter.

### Activation

Les passkeys sont proposées dès que `WEBAUTHN_RP_ID` est réglé ([Configuration](configuration.md#variables-denvironnement)) :

- `WEBAUTHN_RP_ID` : le **domaine** où les navigateurs ouvrent l'interface (`hub.example.org`), jamais une adresse IP ;
  une passkey est liée à ce domaine, le changer rend celles déjà enregistrées inutilisables ;
- `WEBAUTHN_ORIGIN` : l'adresse exacte de l'interface quand ce n'est pas `https://<WEBAUTHN_RP_ID>` (autre port,
  sous-domaine) ;
- l'interface doit être servie en **HTTPS avec un certificat reconnu par le navigateur** (reverse proxy avec Let's
  Encrypt, ou `HTTPS_CERT_FILE`) : les navigateurs refusent WebAuthn en HTTP et, pour Chrome au moins, sur un certificat
  accepté en exception, comme celui émis par le hub. Seul `localhost` fait exception (tests en local).

### Enregistrer une passkey

**Mon compte › Double authentification** : donner un nom (« Bitwarden », « YubiKey »), puis **Activer** (première
passkey) ou **Ajouter**, et suivre la fenêtre du navigateur. Chaque passkey indique si elle est *synchronisée* (gestionnaire, trousseau du système : utilisable sur
plusieurs appareils), sa date d'enregistrement et sa dernière utilisation. Gardez-en **une deuxième en secours** : sans
passkey, seul un accès à l'hôte du hub permet de se reconnecter. **Clé publique** affiche la clé au format PEM,
destinée aux agents (vérification des actions signées par un admin, homelab#306).

À la connexion, après le mot de passe, **Utiliser ma passkey** ouvre la fenêtre du navigateur. Un échec compte comme une
[tentative de connexion](#tentatives-de-connexion) refusée et apparaît au [journal](#journal-des-actions). Le mot de
passe seul n'ouvre pas de session.

### Obligation pour les admins

Avec `MFA_REQUIRED=true`, les comptes `admin` doivent se connecter avec une passkey :

- un admin qui n'en a pas l'enregistre à sa prochaine connexion, sur un écran dédié, avant tout autre accès (l'API lui
  répond `403 passkey_required` jusque-là) ;
- un admin connecté avant l'activation par son seul mot de passe doit se reconnecter avec sa passkey ;
- la dernière passkey d'un admin ne peut pas être supprimée.

Les profils `operator` et `viewer` peuvent en enregistrer une sans y être obligés. Le compte `superadmin` (mot de passe
à usage unique, comptes seulement) et les [clés d'API](#clés-dapi) ne sont pas concernés. `MFA_REQUIRED` reste sans
effet tant que `WEBAUTHN_RP_ID` est vide, pour ne pas bloquer les admins : le hub l'écrit dans ses journaux au
démarrage et la [page Sécurité](securite.md#page-sécurité) le signale.

### État d'un compte

La page **Comptes** rappelle en tête ce que demande le hub (obligatoire pour les admins, facultative, ou non disponible
sans `WEBAUTHN_RP_ID`), réglé dans le compose et jamais depuis l'interface. Le même badge donne l'état de chaque compte,
dans la colonne *2FA* et dans sa fenêtre :

| Badge | Signification |
|---|---|
| Activée · n | le compte a *n* passkeys |
| Désactivée | aucune passkey : connexion par le seul mot de passe |
| À enregistrer | admin sans passkey alors qu'elles sont obligatoires : il l'enregistre à sa prochaine connexion |
| — | compte sans mot de passe (clés d'API seulement) : pas de connexion à l'interface |

**Désactiver**, dans l'onglet *Double authentification*, supprime toutes les passkeys du compte, après confirmation et
passkey redemandée. Sur son propre compte, c'est refusé à un admin quand elles sont obligatoires. Un admin peut le faire
sur un autre compte (passkey perdue, sans passer par l'hôte) : ses sessions sont fermées et, si elles sont
obligatoires, il en enregistre une nouvelle à sa prochaine connexion. Les deux sont tracés au journal.

### Actions sensibles

Un compte qui a une passkey la confirme de nouveau avant une action sensible, quand sa dernière confirmation (connexion
ou action précédente) date de plus de **5 minutes**. L'interface ouvre une fenêtre **Confirmer avec votre passkey**,
puis envoie l'action ; **Annuler** l'abandonne. Une session volée (cookie copié) ne suffit donc pas à ces actions :

| Domaine | Actions |
|---|---|
| Comptes | création, modification, suppression, réinitialisation d'un mot de passe, création d'une clé d'API, ajout ou suppression d'une passkey, désactivation de la double authentification |
| Paramètres | Home Assistant, agents, PBS principal et de secours (jetons compris), clusters Proxmox VE, rôles (Omada…) |
| Standardisation | standard, valeurs propres d'un hôte, clé SSH hors manifeste validée, application du manifeste d'accès |
| Hôtes | commande d'installation d'un agent, révocation de l'agent, suppression de l'hôte |
| Bases de données | restauration d'une base |

Ce qui ne fait que retirer un accès (révoquer une clé d'API, fermer des sessions, déconnecter un PBS) n'est pas
concerné, pas plus que les comptes sans passkey, le `superadmin` et les [clés d'API](#clés-dapi). L'API répond
`403 reauth_required` tant que la confirmation manque ; la confirmation passe par `POST /api/account/reauth/options`
puis `POST /api/account/reauth`. Les confirmations, acceptées ou refusées, sont tracées au [journal](#journal-des-actions).

### Passkey perdue

Un autre admin désactive la double authentification du compte (ci-dessus). Sans autre admin, depuis l'hôte du hub, supprimer les passkeys du compte (ses sessions sont fermées, l'action est tracée au journal) :

```bash
docker compose exec hub hm-admin reset-passkeys <identifiant>
```

L'utilisateur se reconnecte avec son mot de passe et, si les passkeys sont obligatoires, en enregistre une nouvelle.

## Sessions

Une session de l'interface se ferme :

- après **12 heures sans utilisation** (`SESSION_IDLE_HOURS`) ;
- dans tous les cas **7 jours après la connexion** (`SESSION_MAX_DAYS`), même utilisée sans interruption.

Seules les actions de l'utilisateur comptent comme une utilisation : les rafraîchissements automatiques d'un onglet resté
ouvert, sans clavier ni souris depuis une minute, ne prolongent pas la session. La session `superadmin` dure 15 minutes.

L'onglet *Sessions* de la [fenêtre du compte](#fenêtre-dun-compte) liste les navigateurs où le compte est connecté
(navigateur, adresse, dernière utilisation, expiration) ; **Fermer** en ferme une, après confirmation. Dans la page
**Comptes**, la colonne *Sessions* donne le nombre de sessions ouvertes de chaque compte, et un admin peut **fermer toutes
les sessions** d'un autre compte (navigateur perdu ou partagé), depuis le tableau ou sa fenêtre ; ses clés d'API restent
valides. Ces actions sont tracées au [journal](#journal-des-actions).

Les sessions ouvertes avant cette version gardent leur échéance, ramenée à 7 jours au plus à leur première utilisation.

## Flux temps réel

L'interface reçoit les mises à jour en direct (hôtes, tâches, journaux de tâches) par un flux ouvert en continu. Ce flux est fermé dès que son accès disparaît : déconnexion, changement de profil, réinitialisation du mot de passe, suppression du compte, révocation de la clé d'API utilisée. Une session expirée ou un compte supprimé directement en base est aussi détecté, au plus tard au bout d'une minute (revalidation périodique). Le navigateur se reconnecte alors et reçoit un refus.

Les événements ne sont pas filtrés par profil : tous les profils autorisés à lire reçoivent les mêmes que par l'API, y compris les journaux de tâches.

## Journal des actions

L'onglet **Journal** de la page **Comptes** (admins seulement) trace les actions clés sur le hub : **qui a fait quoi**, depuis quelle adresse, avec quel résultat.

| Type d'action | Ce qui est tracé |
|---|---|
| Connexions | connexions (avec ou sans passkey) et déconnexions, confirmations par passkey avant une action sensible, échecs dont les passkeys refusées (regroupés par adresse et par minute), clé d'API inconnue, mot de passe `superadmin` émis par `hm-admin` |
| Comptes | création, modification (nom, profil : ancienne → nouvelle valeur), suppression, réinitialisation du mot de passe, changement de son propre mot de passe, sessions fermées, passkey ajoutée ou supprimée, double authentification désactivée (par le compte, par un admin ou par `hm-admin reset-passkeys`) |
| Clés d'API | création et révocation (nom de la clé) |
| Hôtes | ajout, suppression, commande d'installation émise, enrôlement de l'agent (adresse, empreinte du certificat), révocation |
| Actions | toute tâche lancée par un compte, une clé d'API ou Home Assistant (les tâches planifiées restent dans **Activité**) |
| Paramètres | Home Assistant, agents, PBS principal et de secours, clusters Proxmox VE, rôles : champs modifiés avec leurs anciennes et nouvelles valeurs |
| Standardisation | standard, valeurs propres d'un hôte, application du manifeste d'accès, clé SSH hors manifeste validée ou annulée (empreinte, compte) |

Chaque entrée garde le nom de l'acteur : le compte (et la clé d'API utilisée), ou « hôte · agent » quand c'est la machine elle-même (enrôlement). Elle reste lisible après la suppression du compte. Les filtres portent sur l'utilisateur, le type d'action et la période.

- **Aucun secret** n'est enregistré : ni mot de passe, ni secret de jeton, ni code d'enrôlement. Un champ secret modifié apparaît par son seul nom, une clé SSH par son empreinte.
- **Les entrées ne peuvent être ni modifiées ni supprimées** depuis le hub. MongoDB les efface au bout d'**un an**.
- Le nom saisi lors d'un échec de connexion n'est gardé que s'il correspond à un compte (sinon : « compte inconnu »), pour ne pas conserver un mot de passe tapé dans le mauvais champ.
- Les commandes reçues par MQTT apparaissent sous **Home Assistant**, avec leur topic : le broker ne dit pas qui les a publiées.
- Derrière un reverse proxy, l'adresse enregistrée est celle du client quand le proxy la transmet (`X-Forwarded-For`, déclaré dans `TRUST_PROXY`), sinon celle du proxy (voir [Configuration](configuration.md)).

Le journal protège contre l'abus d'un compte ou d'une clé d'API. Il ne protège pas contre une personne qui accède directement à la base MongoDB.

Les tâches indiquent aussi qui les a lancées (**Activité**, détail d'une tâche).
