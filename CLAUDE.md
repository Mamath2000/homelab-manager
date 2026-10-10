# homelab-manager

## Interface (`web/`)

- **Boîtes de confirmation (`ConfirmModal`) réservées à deux cas** :
  - action **destructive** ou qui coupe un service : suppression, révocation, reboot, arrêt de stack, `apt autoremove`… (`danger`) ;
  - action **groupée** (plusieurs hôtes, stacks ou agents d'un coup) : la modale sert d'aperçu des cibles.
- Toute autre action (mise à jour unitaire d'un agent, d'un hôte, d'un paquet, d'une stack ; démarrer/redémarrer ; réglage
  réversible) se lance **directement** au clic : `loading` sur le bouton, retour par toast ou par le job.
