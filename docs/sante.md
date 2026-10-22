# Santé

L'écran **Santé** donne une vue d'ensemble des hôtes compatibles. La fiche de chaque hôte affiche ses mesures détaillées et permet, si l'agent l'annonce, de sélectionner les disques SMART suivis.

## Collecte et rétention

Les agents Linux, Windows et Home Assistant OS envoient des rapports typés indépendamment :

| Mesures | Défaut | Plage réglable |
| --- | ---: | ---: |
| CPU, mémoire, charge Unix | 30 s | 10 s – 1 h |
| Usage des volumes | 5 min | 1 min – 24 h |
| SMART | 24 h | 10 min – 30 jours |

La charge `load 1/5/15` est envoyée sur Unix ; Windows n'a pas ces valeurs. Home Assistant OS expose l'occupation du disque de données par l'API Supervisor ; ses disques ne sont pas activés pour SMART par défaut.

MongoDB stocke les échantillons dans `healthMetrics`, indexés par hôte, catégorie et horodatage. Un index TTL supprime automatiquement les mesures après **48 h**. La courbe UI montre la dernière heure : il n'y a pas d'historique long terme.

Les fréquences et seuils globaux se règlent dans **Paramètres → Santé**. Valeurs par défaut :

- CPU > 90 % pendant 5 min ;
- mémoire > 90 % pendant 5 min ;
- volume utilisé à 80 % ;
- température SMART à 70 °C ;
- usure NVMe à 80 % ; tout secteur réalloué est signalé.

CPU, mémoire, volume, température et usure NVMe conservent une marge de résolution de 5 points pour limiter les oscillations près du seuil. Les alertes sont ajoutées au domaine Santé, à la chronologie et aux notifications Home Assistant si l'intégration est activée.

## SMART

SMART est volontairement **opt-in hôte par hôte**. Sur un agent Linux qui annonce la capacité `smart`, la fiche de l'hôte permet de saisir les périphériques physiques (par exemple `/dev/sda` ou `/dev/nvme0`). Seuls ces chemins sont transmis à l'agent et interrogés avec `smartctl`; aucune détection ou requête SMART automatique n'est faite sur les disques virtualisés. Le paquet `smartmontools` doit être installé et l'agent doit disposer des droits nécessaires.

Les rapports affichent l'état global, la température, les secteurs réalloués et l'usure NVMe lorsque les données sont fournies par le disque. Les VMs/LXC sans accès au périphérique physique et les contrôleurs/RAID non exposés par `smartctl` ne remontent pas ces détails.

## Limites de plateforme

- Windows collecte CPU, mémoire et volumes ; la charge Unix et SMART ne s'appliquent pas.
- HAOS s'appuie sur les statistiques Linux visibles dans l'add-on pour CPU/mémoire/charge, sur `/host/info` du Supervisor pour le disque de données, et n'active pas SMART.
- Les métriques absentes d'une plateforme ou d'un agent sont laissées vides, et non remplacées par zéro.
