# homelab-manager

## Interface (`web/`)

- **Boîtes de confirmation (`ConfirmModal`) réservées à deux cas** :
  - action **destructive** ou qui coupe un service : suppression, révocation, reboot, arrêt de stack, `apt autoremove`… (`danger`) ;
  - action **groupée** (plusieurs hôtes, stacks ou agents d'un coup) : la modale sert d'aperçu des cibles.
- Toute autre action (mise à jour unitaire d'un agent, d'un hôte, d'un paquet, d'une stack ; démarrer/redémarrer ; réglage
  réversible) se lance **directement** au clic : `loading` sur le bouton, retour par toast ou par le job.

## Lancement local (`make dev` / `make start`)

- Les ports du hub de test sont **figés** dans `.env.local` (gitignoré, `override` lu par le Makefile ; dev-math : interface 3001,
  agents 3444) : les agents de test sont enrôlés sur ce port, en changer les déconnecte.
- **Ne jamais passer `PORT` / `AGENT_TLS_PORT`** (ni variable d'environnement) à `make dev` / `make start`, ni lancer le hub autrement.
- **Port déjà utilisé : ne pas en prendre un autre.** S'arrêter, dire quel processus l'occupe (`ss -ltnp`), et demander à l'utilisateur
  (arrêter l'instance existante, la réutiliser…). Vaut pour tout port (hub, Vite, Mongo…).
