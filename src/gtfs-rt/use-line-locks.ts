import { VERIFICATION_STALENESS } from "../config.js";
import { isDeclaredDestination } from "./verify-vehicle.js";

/** Ce que le verrou retient d'un véhicule. */
export type LineLock = {
	/** Ligne au format du GTFS publié (« TCAR:91 »). */
	routeId: string;
	/**
	 * Dernière confirmation, en secondes epoch : publication sur cette ligne, ou girouette fraîche qui
	 * lui appartient.
	 */
	confirmedAt: number;
};

/**
 * Le verrou de ligne : la ligne sur laquelle chaque véhicule a été publié, et dont il ne bouge plus
 * tant que sa girouette reste l'une des destinations de cette ligne.
 *
 * La girouette ne départage pas deux lignes qui partagent une destination : T1 et T5 vont toutes
 * deux à « Mont aux Malades », et le SAE, sur leur tronc commun, prête volontiers à un véhicule la
 * course de l'autre. Chacune des deux annonces passe alors la vérification. Le verrou départage par
 * l'historique : un véhicule publié sur T1 reste sur T1 tant que rien ne prouve qu'il en est sorti,
 * et le SAE qui le dit sur T5 n'est pas cru.
 *
 * Il tombe dès qu'une girouette fraîche n'appartient plus à la ligne verrouillée — autre ligne,
 * retour au dépôt, girouette inconnue —, et le véhicule est alors libre de reprendre la ligne que la
 * vérification confirmera. Une girouette muette ou périmée ne prouve rien : elle ne lève pas le
 * verrou, mais elle ne le confirme pas non plus, et un verrou qu'aucune girouette n'est venue
 * confirmer depuis {@link VERIFICATION_STALENESS} tombe de lui-même (cf. {@link observe}).
 *
 * Le verrou se pose à chaque publication (cf. {@link lock}), y compris quand la girouette ne
 * départageait pas : un véhicule qui sort du dépôt sur T5 vers Mont aux Malades est donc verrouillé
 * dès sa première publication, sans attendre de passer à Champlain. C'est un pari sur le SAE : il
 * prend sa course du conducteur au départ, et se trompe en route. S'il se trompait dès le départ, le
 * verrou garderait le véhicule sur la mauvaise ligne jusqu'au terminus — la girouette, en changeant,
 * l'en libérerait alors.
 *
 * Le flux de vérification, lorsqu'il répond, passe avant le verrou (cf. `verifyVehicle`) : la ligne
 * qu'il confirme est publiée, et le verrou la suit.
 *
 * `restored` rend au module les verrous du dernier arrêt du producteur (cf. `loadState`).
 */
export function useLineLocks(restored: Iterable<readonly [string, LineLock]> = []) {
	const locks = new Map<string, LineLock>(restored);

	return {
		/** L'état des verrous, tel qu'il sera réécrit sur disque. */
		snapshot(): [string, LineLock][] {
			return [...locks];
		},

		/**
		 * Confronte le verrou du véhicule à sa girouette et renvoie la ligne qui en sort, `undefined`
		 * s'il n'en a pas ou plus :
		 *
		 *  - girouette vide (instantané SAE muet ou périmé) : rien ne change, le verrou tient jusqu'à
		 *    {@link VERIFICATION_STALENESS} après sa dernière confirmation ;
		 *  - girouette qui appartient à la ligne verrouillée : le verrou est confirmé ;
		 *  - toute autre girouette, dépôt compris : le verrou est levé.
		 */
		observe(vehicleId: string, destinationName: string, nowSeconds: number): string | undefined {
			const lock = locks.get(vehicleId);
			if (lock === undefined) return undefined;

			if (nowSeconds - lock.confirmedAt > VERIFICATION_STALENESS) {
				locks.delete(vehicleId);
				return undefined;
			}

			if (!destinationName) return lock.routeId;

			if (!isDeclaredDestination(lineOf(lock.routeId), destinationName)) {
				locks.delete(vehicleId);
				console.log(
					`\t🔓 ${vehicleId.padEnd(4, " ")}  ${lock.routeId.padEnd(10, " ")} — déverrouillé, girouette "${destinationName}".`,
				);
				return undefined;
			}

			lock.confirmedAt = nowSeconds;
			return lock.routeId;
		},

		/** Verrouille le véhicule sur la ligne où il vient d'être publié. */
		lock(vehicleId: string, routeId: string, nowSeconds: number): void {
			const previous = locks.get(vehicleId);
			if (previous?.routeId !== routeId) {
				console.log(
					`\t🔒 ${vehicleId.padEnd(4, " ")}  ${routeId.padEnd(10, " ")} — verrouillé${previous ? `, au lieu de ${previous.routeId}` : ""}.`,
				);
			}

			locks.set(vehicleId, { routeId, confirmedAt: nowSeconds });
		},

		/** Oublie les verrous qu'aucune girouette n'a confirmés depuis {@link VERIFICATION_STALENESS}. */
		prune(nowSeconds: number): void {
			for (const [vehicleId, lock] of locks) {
				if (nowSeconds - lock.confirmedAt > VERIFICATION_STALENESS) locks.delete(vehicleId);
			}
		},
	};
}

// ---

/** « TCAR:91 » → « 91 », la clé de `LINE_DESTINATIONS`. */
function lineOf(routeId: string): string {
	return routeId.split(":").at(-1) ?? "";
}
