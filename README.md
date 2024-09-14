# Producteur GTFS-RT - Transdev Rouen (TCAR)

Ce programme génère deux flux GTFS-RT à partir du service de géolocalisation du site [myastuce.fr](https://myastuce.fr).  
En support, le flux GTFS-RT officiel vient corriger les anomalies connues du nouveau service pour garantir la fiabilité des données.

Une version de ce programme est en service [ici](https://gtfs.bus-tracker.fr/gtfs-rt/tcar/) pour [Bus Tracker](https://bus-tracker.fr).

## Mise en service

1. Installer les dépendances : `npm install`
2. Transpiler le programme : `npm run build`
3. Démarrer le programme : `npm run start`

Pour changer le port (par défaut `8080`), utiliser la variable d'environnement `PORT`.

## Utilisation

En théorie, le programme fonctionne en parfaite autonomie.  
Il se peut qu'il doive être manuellement redémarré en cas de défaillance du WebSocket (jamais observé dans les faits).

| **Route**                     | **Description**                                  |
| ----------------------------- | ------------------------------------------------ |
| `GET /vehicle-positions`      | Position des véhicules (format Protobuf)         |
| `GET /vehicle-positions.json` | Position des véhicules (format JSON)             |
| `GET /trip-updates`           | Horaires de passage temps-réel (format Protobuf) |
| `GET /trip-updates.json`      | Horaires de passage temps-réel (format JSON)     |

## Avantages par rapport au GTFS-RT officiel

- Les courses renvoyées sont cohérentes (pas de course du samedi un mercredi, par exemple)
- La fréquence de rafraichissement est plus élevée (en moyenne toutes les 20 à 30 secondes)
- Les horaires de passage non monitorés sont clairement identifiés (`NO_DATA`)

## Failles du service de géolocalisation

### Zones non monitorées

**Constat :** en zone non monitorée, un véhicule n'est plus émis à travers le service.  
**Problème :** on ne peut plus suivre le véhicule, ni sa desserte.  
**Solution :** si le GTFS-RT officiel dispose d'une information plus récente, alors celle-ci est utilisée.

### Swap étrange de ligne

**Constat :** sans raison apparente, un véhicule d'une ligne A peut très bien être swap sur une ligne B pour une durée arbitraire.  
**Problème :** l'information est alors complètement trompeuse et non exploitable.  
**Solution :** une liste des destinations SAE autorisées pour chaque ligne + le GTFS-RT officiel permet d'ignorer les véhicules problématiques.

Voir [is-sus.ts](./src/utils/is-sus.ts) pour plus de détails sur le fonctionnement de "l'algorithme".
