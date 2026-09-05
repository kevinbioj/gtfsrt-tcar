import { DEPOT_DESTINATIONS, LINE_DESTINATIONS } from "../config.js";
import { normalizeStopName } from "./use-static-gtfs.js";
import type { VerifiedVehicle } from "./use-verification-feed.js";

/** Ce que le flux source annonce d'un véhicule, réduit à ce que la vérification examine. */
export type ObservedVehicle = {
	/** Ligne au format du GTFS publié (« TCAR:92 »), telle que la source l'écrit. */
	routeId: string;
	/** Numéro de ligne seul (« 92 »), clé de {@link LINE_DESTINATIONS}. */
	lineId: string;
	directionId: number;
};

/** Ce qui a confirmé le véhicule : le flux de vérification, la girouette à défaut, ou les deux. */
export type VerifiedBy = "feed" | "destination" | "both";

export type Verification =
	| { valid: true; by: VerifiedBy }
	| {
			valid: false;
			/** La ligne et le sens du flux de vérification, `undefined` s'il ignore le véhicule. */
			verified: { routeId: string; directionId: number } | undefined;
			/** La girouette relevée, chaîne vide si l'instantané SAE ignore le véhicule. */
			destinationName: string;
	  };

/**
 * Vrai si le véhicule affiche un retour au dépôt. Le SAE continue de lui prêter une course, mais
 * elle ne mène plus personne nulle part : rien de ce qu'il en dit n'a à être republié.
 */
export function isDepotDestination(destinationName: string): boolean {
	if (!destinationName) return false;

	const wanted = normalizeStopName(destinationName);
	return wanted !== "" && DEPOT_DESTINATIONS.some((name) => normalizeStopName(name) === wanted);
}

/**
 * Confronte la ligne et le sens qu'annonce le flux source à deux sources indépendantes, dans cet
 * ordre :
 *
 *  1. le **flux de vérification** (Astuce), qui porte la ligne et le sens réels du véhicule. Dès
 *     qu'il en a un relevé frais, il tranche seul : la ligne et le sens qu'il donne font foi, et
 *     aucune girouette ne rattrape le véhicule qu'il dément ;
 *  2. la **girouette** de l'instantané SAE, qui ne décide qu'à défaut — flux muet sur ce véhicule,
 *     ou relevé périmé. Elle est confrontée aux destinations déclarées de la ligne annoncée : une
 *     destination qui lui appartient vaut confirmation, faute de mieux.
 *
 * Sans aucune des deux, le véhicule n'est pas publiable : rien ne confirme ce que la source annonce.
 *
 * `verified` est `undefined` quand le flux ignore le véhicule ou que son relevé est périmé — les
 * deux revenant au même ; `destinationName` est vide dans les mêmes cas. Ces deux filtres sont
 * appliqués par l'appelant.
 */
export function verifyVehicle(
	observed: ObservedVehicle,
	verified: VerifiedVehicle | undefined,
	destinationName: string,
): Verification {
	const destinationMatches = isDeclaredDestination(observed.lineId, destinationName);

	// Le flux de vérification tranche avant tout le reste : quand il situe le véhicule sur une autre
	// ligne ou dans l'autre sens, rien ne le rattrape — pas même une girouette propre à la ligne.
	if (verified !== undefined) {
		if (verified.routeId !== observed.routeId || verified.directionId !== observed.directionId) {
			return {
				valid: false,
				verified: { routeId: verified.routeId, directionId: verified.directionId },
				destinationName,
			};
		}

		return { valid: true, by: destinationMatches ? "both" : "feed" };
	}

	// Muet sur ce véhicule, il laisse la girouette décider.
	if (destinationMatches) return { valid: true, by: "destination" };

	return { valid: false, verified: undefined, destinationName };
}

// ---

/**
 * Vrai si la girouette figure parmi les destinations déclarées de sa ligne. Une ligne absente de la
 * table n'en a aucune : rien n'y est reconnu.
 */
function isDeclaredDestination(lineId: string, destinationName: string): boolean {
	const destinations = LINE_DESTINATIONS.get(lineId);
	if (destinations === undefined) return false;

	const wanted = normalizeStopName(destinationName);
	if (!wanted) return false;

	return destinations.some((name) => normalizeStopName(name) === wanted);
}
