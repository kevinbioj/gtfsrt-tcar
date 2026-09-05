import type GtfsRealtime from "gtfs-realtime-bindings";

import { IMMOBILITY_LIMIT } from "../config.js";

/** Ce que le suivi retient d'un véhicule d'un relevé à l'autre. */
type TrackedVehicle = {
	/** Empreinte de la dernière position distincte relevée. */
	signature: string;
	/** La position de ce dernier mouvement, telle qu'elle sera republiée. */
	position: GtfsRealtime.transit_realtime.IPosition;
	/** Horodatage source de ce dernier mouvement, en secondes epoch. */
	movedAt: number;
};

export type Movement =
	/** Première apparition : rien ne dit encore si le véhicule roule, on n'en publie rien. */
	| { kind: "first-sight" }
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
 * date de la source que lorsqu'elle accompagne un mouvement.
 *
 * Rien n'y périme : un véhicule qui assure un service le matin et repart le soir doit retrouver au
 * réveil l'empreinte qu'il avait laissée, faute de quoi il repasse par une première apparition et
 * perd un relevé. La péremption ne concerne que ce qui est publié (cf. `useVehicleRegistry`).
 */
export function useMovementTracker() {
	const tracked = new Map<string, TrackedVehicle>();

	return {
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
				tracked.set(vehicleId, { signature, position, movedAt: timestamp });
				return { kind: "first-sight" };
			}

			if (previous.signature !== signature) {
				previous.signature = signature;
				previous.position = position;
				previous.movedAt = timestamp;
				return { kind: "moved", position, timestamp };
			}

			// Immobile de longue date : la source a beau continuer d'en parler, elle ne le voit plus.
			if (nowSeconds - previous.movedAt > IMMOBILITY_LIMIT) return { kind: "frozen" };

			return { kind: "still", position: previous.position, timestamp: previous.movedAt };
		},
	};
}
