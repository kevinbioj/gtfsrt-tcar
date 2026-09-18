import type GtfsRealtime from "gtfs-realtime-bindings";

import { IMMOBILITY_LIMIT } from "../config.js";

/**
 * Flux d'où vient une position. Les deux ne relèvent jamais exactement la même coordonnée pour un
 * même véhicule : leurs empreintes ne se mélangent pas (cf. {@link TrackedVehicle}).
 */
export type PositionSource = "astuce" | "cityway";

/** Ce que le suivi retient d'un véhicule pour un flux donné. */
export type PositionReading = {
	/** Empreinte de la dernière position distincte relevée sur ce flux. */
	signature: string;
	/** La position de ce dernier mouvement, telle qu'elle sera republiée. */
	position: GtfsRealtime.transit_realtime.IPosition;
	/**
	 * Horodatage source du dernier mouvement constaté sur ce flux, en secondes epoch. `undefined`
	 * tant qu'aucun mouvement n'a été constaté : la date de la source ne le remplace jamais, c'est
	 * précisément elle qu'on refuse de croire.
	 */
	movedAt: number | undefined;
};

/** Ce que le suivi retient d'un véhicule d'un relevé à l'autre. */
export type TrackedVehicle = {
	/**
	 * Une empreinte par flux. Deux sources ne donnent jamais exactement les mêmes coordonnées : sous
	 * une empreinte unique, chaque bascule de l'une à l'autre passerait pour un mouvement et
	 * réhorodaterait le véhicule à tort.
	 */
	readings: Partial<Record<PositionSource, PositionReading>>;
};

export type Movement =
	/**
	 * Aucun mouvement constaté depuis le démarrage : rien ne dit que le véhicule roule, on n'en publie
	 * rien. C'est le cas de sa première apparition, et de tous les relevés qui suivent tant qu'il n'a
	 * pas bougé.
	 */
	| { kind: "unproven" }
	/** Le véhicule a bougé : la source dit vrai, ce relevé date bien de maintenant. */
	| { kind: "moved"; position: GtfsRealtime.transit_realtime.IPosition; timestamp: number }
	/**
	 * Immobile depuis moins de {@link IMMOBILITY_LIMIT} : le reste de l'entrée se met à jour, mais la
	 * position et sa date restent celles du dernier mouvement constaté.
	 */
	| { kind: "still"; position: GtfsRealtime.transit_realtime.IPosition; timestamp: number }
	/**
	 * Immobile depuis plus longtemps, et sans départ à attendre : le véhicule est déconnecté, on n'en
	 * relaie plus rien.
	 */
	| { kind: "frozen" };

/**
 * Date les positions d'après le mouvement réellement constaté.
 *
 * La source réhorodate « maintenant » des véhicules qu'elle n'a plus au bout du fil : sa date ne dit
 * donc rien tant que la position n'a pas changé. Un véhicule éteint depuis des heures y paraît ainsi
 * relevé à la seconde, et le publier tel quel le ferait vivre indéfiniment chez le consommateur.
 *
 * Le suivi compare donc chaque relevé au précédent, sur l'empreinte de sa position, et ne retient la
 * date de la source que lorsqu'elle accompagne un mouvement. Tant qu'un véhicule n'a pas bougé sous
 * les yeux du suivi, il n'a pas de date du tout : au démarrage, tout le parc que la source annonce
 * attend donc son premier mouvement pour entrer dans le feed, et non le relevé suivant.
 *
 * La comparaison se fait flux par flux, la publication véhicule par véhicule : les positions de deux
 * sources ne coïncident jamais tout à fait, et les confondre fabriquerait un mouvement à chaque
 * bascule. Ce qui est constaté sur l'une vaut en revanche pour l'autre — un véhicule vu rouler reste
 * vu rouler, quel que soit le flux qui le relève ensuite.
 *
 * Rien n'y périme : un véhicule qui assure un service le matin et repart le soir doit retrouver au
 * réveil l'empreinte qu'il avait laissée, faute de quoi il repasse par une première apparition et
 * perd un relevé. La péremption ne concerne que ce qui est publié (cf. `useVehicleRegistry`).
 *
 * `restored` reprend le suivi là où le dernier arrêt du producteur l'avait laissé (cf.
 * `loadState`) : sans lui, un redémarrage remettrait tout le parc en attente d'un premier
 * mouvement.
 */
export function useMovementTracker(restored: Iterable<readonly [string, TrackedVehicle]> = []) {
	const tracked = new Map<string, TrackedVehicle>(restored);

	return {
		/** L'état du suivi, tel qu'il sera réécrit sur disque. */
		snapshot(): [string, TrackedVehicle][] {
			return [...tracked];
		},

		/**
		 * Confronte le relevé au précédent du même flux et dit ce qu'il faut en faire. `timestamp` est
		 * la date brute de la source, en secondes epoch ; elle n'est retenue que si le véhicule a bougé.
		 *
		 * `awaitingDeparture` dit qu'une course attend encore ce véhicule (cf. `awaitsDeparture`) : son
		 * immobilité s'explique alors d'elle-même — il patiente à son terminus — et la limite ne joue
		 * pas, quelle que soit la durée de l'attente.
		 */
		observe(
			vehicleId: string,
			source: PositionSource,
			position: GtfsRealtime.transit_realtime.IPosition,
			timestamp: number,
			nowSeconds: number,
			awaitingDeparture: boolean,
		): Movement {
			const signature = `${position.latitude},${position.longitude},${position.bearing}`;

			let entry = tracked.get(vehicleId);
			if (entry === undefined) {
				entry = { readings: {} };
				tracked.set(vehicleId, entry);
			}

			const readings = Object.values(entry.readings);
			// Un véhicule vu bouger sur n'importe lequel des flux est un véhicule qui roule. Sans cela, sa
			// première apparition sur le second flux le ferait sortir du feed comme s'il venait d'être
			// découvert, alors qu'on le suit déjà depuis l'autre.
			const proven = readings.some((reading) => reading.movedAt !== undefined);

			const previous = entry.readings[source];

			// Première empreinte sur ce flux. Elle vaut constat si le véhicule est déjà prouvé par
			// ailleurs, et seulement dans ce cas : découvert par ce flux-là, il attend d'y bouger.
			if (previous === undefined) {
				entry.readings[source] = { signature, position, movedAt: proven ? timestamp : undefined };
				return proven ? { kind: "moved", position, timestamp } : { kind: "unproven" };
			}

			if (previous.signature !== signature) {
				previous.signature = signature;
				previous.position = position;
				previous.movedAt = timestamp;
				return { kind: "moved", position, timestamp };
			}

			// Toujours à la place où on l'a trouvé au démarrage : il n'a jamais bougé sous nos yeux, et la
			// date que la source lui prête ne vaut pas constat. Il attend son premier mouvement.
			if (previous.movedAt === undefined) return { kind: "unproven" };

			// Immobile de longue date : la source a beau continuer d'en parler, elle ne le voit plus. On
			// s'en remet au mouvement le plus récent tous flux confondus — un flux qui perd le véhicule ne
			// doit pas le figer quand l'autre le voit rouler. À moins qu'une course ne l'attende : un
			// véhicule mis à quai deux heures avant son départ est immobile pour une raison qu'on connaît,
			// et il reste suivi jusqu'à ce qu'il reparte.
			const lastMovedAt = Math.max(...readings.map((reading) => reading.movedAt ?? 0));
			if (nowSeconds - lastMovedAt > IMMOBILITY_LIMIT && !awaitingDeparture) return { kind: "frozen" };

			return { kind: "still", position: previous.position, timestamp: previous.movedAt };
		},
	};
}
