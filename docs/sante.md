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

Sous Unix, les montages `loop` (images/conteneurs), les pseudo-filesystems (`overlay`, `tmpfs`, `proc`, etc.) et `/boot/efi` sont exclus de la liste des volumes. Les partitions et volumes RAID restent suivis. Une machine virtuelle qui présente son disque virtuel comme un disque local ne permet pas à l'agent de savoir si le stockage sous-jacent est physique.

MongoDB stocke les échantillons dans `healthMetrics`, indexés par hôte, catégorie et horodatage. Un index TTL supprime automatiquement les mesures après **48 h**. La courbe UI montre la dernière heure : il n'y a pas d'historique long terme.

Les fréquences et seuils globaux se règlent dans **Paramètres → Santé**. Seuils par défaut (warning / alerte) :

- CPU : 75 / 90 % ;
- mémoire : 80 / 90 % ;
- volume : 75 / 90 % ;
- température SMART : 60 / 70 °C ;
- usure NVMe : 70 / 85 % ; tout secteur réalloué est signalé immédiatement.

La durée est réglable séparément pour les mesures système (CPU/mémoire) et SMART. CPU et mémoire demandent 5 minutes continues par défaut ; les volumes déclenchent immédiatement dès le franchissement d'un seuil, et SMART déclenche immédiatement par défaut. Une durée de 0 signifie immédiat pour les catégories temporisées. Les alertes actives conservent une hystérésis de 5 points pour éviter les oscillations près du seuil. Les alertes sont ajoutées au domaine Santé, à la chronologie et aux notifications Home Assistant si l'intégration est activée.

## SMART

SMART est volontairement **opt-in hôte par hôte**. Sur un agent Linux qui annonce la capacité `smart`, la fiche de l'hôte permet de saisir les périphériques physiques (par exemple `/dev/sda` ou `/dev/nvme0`). Seuls ces chemins sont transmis à l'agent et interrogés avec `smartctl`; aucune détection ou requête SMART automatique n'est faite sur les disques virtualisés. Le paquet `smartmontools` doit être installé et l'agent doit disposer des droits nécessaires.

La configuration SMART n'est pas proposée pour les hôtes que l'agent identifie comme virtualisés, et le hub n'envoie pas de périphériques SMART configurés à ces agents.

Les rapports affichent l'état global, la température, les secteurs réalloués et l'usure NVMe lorsque les données sont fournies par le disque. Les VMs/LXC sans accès au périphérique physique et les contrôleurs/RAID non exposés par `smartctl` ne remontent pas ces détails.

## Limites de plateforme

- Windows collecte CPU, mémoire et volumes ; la charge Unix et SMART ne s'appliquent pas.
- HAOS s'appuie sur les statistiques Linux visibles dans l'add-on pour CPU/mémoire/charge, sur `/host/info` du Supervisor pour le disque de données, et n'active pas SMART.
- Les métriques absentes d'une plateforme ou d'un agent sont laissées vides, et non remplacées par zéro.
