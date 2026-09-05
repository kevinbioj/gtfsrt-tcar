import type GtfsRealtime from "gtfs-realtime-bindings";

import { IMMOBILITY_LIMIT } from "../config.js";

/** Ce que le suivi retient d'un véhicule d'un relevé à l'autre. */
export type TrackedVehicle = {
	/** Empreinte de la dernière position distincte relevée. */
	signature: string;
	/** La position de ce dernier mouvement, telle qu'elle sera republiée. */
	position: GtfsRealtime.transit_realtime.IPosition;
	/**
	 * Horodatage source du dernier mouvement constaté, en secondes epoch. `undefined` tant qu'aucun
	 * mouvement n'a été constaté : la date de la source ne le remplace jamais, c'est précisément elle
	 * qu'on refuse de croire.
	 */
	movedAt: number | undefined;
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
	/** Immobile depuis plus longtemps : le véhicule est déconnecté, on n'en relaie plus rien. */
	| { kind: "frozen" };

/**
 * Date les positions du flux source d'après le mouvement réellement constaté.
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
		 * Confronte le relevé au précédent et dit ce qu'il faut en faire. `timestamp` est la date brute
		 * de la source, en secondes epoch ; elle n'est retenue que si le véhicule a bougé.
		 */
		observe(
			vehicleId: string,
			position: GtfsRealtime.transit_realtime.IPosition,
			timestamp: number,
			nowSeconds: number,
		): Movement {
			const signature = `${position.latitude},${position.longitude},${position.bearing}`;
			const previous = tracked.get(vehicleId);

			// Première apparition : rien ne dit depuis quand le véhicule est là, ni s'il roule. On retient
			// seulement où il est, de quoi dater son prochain mouvement.
			if (previous === undefined) {
				tracked.set(vehicleId, { signature, position, movedAt: undefined });
				return { kind: "unproven" };
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

			// Immobile de longue date : la source a beau continuer d'en parler, elle ne le voit plus.
			if (nowSeconds - previous.movedAt > IMMOBILITY_LIMIT) return { kind: "frozen" };

			return { kind: "still", position: previous.position, timestamp: previous.movedAt };
		},
	};
}
