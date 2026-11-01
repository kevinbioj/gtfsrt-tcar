import { DETOUR_RUN_SLACK } from "../config.js";
import type { StaticGtfs, TripStop } from "../gtfs-rt/use-static-gtfs.js";
import { type Coordinates, haversine, projectOnShape, type ShapePoint } from "../utils/geometry.js";
import type { ProvisionalStop } from "./store.js";

/**
 * Un arrêt de la course telle qu'elle roule une fois déviée, et son abscisse sur le trajet qu'elle
 * suit alors.
 *
 * `stopSequence` est celui de l'horaire théorique pour un arrêt que la déviation laisse desservi, et
 * `null` pour un arrêt de substitution : la position publiée désigne la course d'origine, dont
 * aucun rang ne lui correspond.
 */
export type ItineraryStop = { stopId: string; stopSequence: number | null; distance: number };

/** Le chemin que suit une course déviée, et les arrêts qu'elle y dessert, dans l'ordre. */
export type DetourItinerary = {
	/**
	 * Ce qui identifie le trajet : deux abscisses ne se comparent que sur le même (cf.
	 * `useVehicleLocator`).
	 */
	key: string;
	shape: ShapePoint[];
	stops: ItineraryStop[];
};

/** Une course déviée un jour donné : son itinéraire, et quand elle roule, en secondes epoch. */
export type DetouredRun = { departure: number; arrival: number; itinerary: DetourItinerary };

/** tripId → ses circulations déviées, une par journée de service où elle l'est. */
export type DetourItineraries = ReadonlyMap<string, readonly DetouredRun[]>;

/** Une modification publiée, vue de l'itinéraire : la plage qu'elle remplace, et par quoi. */
export type ItineraryModification = {
	startIndex: number;
	endIndex: number;
	/** `null` pour une modification de tracé seul : elle ne remplace aucun arrêt. */
	endStopId: string | null;
	stops: readonly { stopId: string }[];
};

/**
 * La circulation déviée de cette course qui roule en ce moment, s'il y en a une.
 *
 * La position ne dit pas de quelle journée de service relève la course : on prend celle dont
 * l'horaire encadre l'instant, à {@link DETOUR_RUN_SLACK} près — un retard, une avance au départ.
 * Le même `trip_id` d'un autre jour en est à vingt-quatre heures, il ne s'y confond pas.
 */
export function detouredRun(
	itineraries: DetourItineraries,
	tripId: string,
	nowSeconds: number,
): DetouredRun | undefined {
	let best: { run: DetouredRun; gap: number } | undefined;
	for (const run of itineraries.get(tripId) ?? []) {
		const gap = Math.max(0, run.departure - nowSeconds, nowSeconds - run.arrival);
		if (gap > DETOUR_RUN_SLACK || (best !== undefined && gap >= best.gap)) continue;
		best = { run, gap };
	}
	return best?.run;
}

/**
 * L'itinéraire d'une course une fois ses modifications appliquées : le trajet recousu s'il y en a
 * un — sinon celui d'origine —, et ses arrêts tels que la spécification les recompose, chaque plage
 * remplacée cédant la place à ses arrêts de substitution.
 *
 * Les abscisses se reportent exactement là où le trajet reprend l'itinéraire d'origine : les arrêts
 * desservis hors des tronçons dessinés y gardent la leur, décalée de ce que les tronçons ont
 * allongé ou raccourci. Les autres — arrêts de substitution, arrêts restés desservis sur un tronçon
 * dessiné — se projettent sur le trajet, entre leurs voisins : la suite reste ainsi dans l'ordre de
 * la course, même sur un trajet qui repasse au même endroit.
 *
 * Un arrêt qu'on ne sait pas situer — sans coordonnées — est laissé de côté.
 */
export function buildItinerary(
	gtfs: StaticGtfs,
	provisional: ReadonlyMap<string, ProvisionalStop>,
	key: string,
	original: ShapePoint[],
	spliced: { points: readonly Coordinates[]; origins: readonly (number | null)[] } | null,
	schedule: readonly TripStop[],
	modifications: readonly ItineraryModification[],
): DetourItinerary {
	const shape = spliced === null ? original : withDistances(spliced.points);

	/** Les arrêts de la course modifiée, et l'abscisse d'origine de ceux qui en ont une. */
	const sequence: { stopId: string; stopSequence: number | null; anchor: number | undefined }[] = [];
	const replacing = modifications
		.filter((modification) => modification.endStopId !== null)
		.sort((a, b) => a.startIndex - b.startIndex);
	for (let index = 0; index < schedule.length; index += 1) {
		const replaced = replacing.find((modification) => modification.startIndex === index);
		if (replaced !== undefined) {
			for (const stop of replaced.stops) sequence.push({ stopId: stop.stopId, stopSequence: null, anchor: undefined });
			index = Math.max(index, replaced.endIndex);
			continue;
		}
		const stop = schedule[index] as TripStop;
		sequence.push({ stopId: stop.stopId, stopSequence: stop.stopSequence, anchor: stop.distance });
	}

	// Première passe : les arrêts que l'itinéraire d'origine situe sur le trajet, dans l'ordre.
	const anchored: (number | undefined)[] = [];
	let floor = Number.NEGATIVE_INFINITY;
	for (const stop of sequence) {
		const distance =
			stop.anchor === undefined || !Number.isFinite(stop.anchor)
				? undefined
				: spliced === null
					? stop.anchor
					: carry(original, shape, spliced.origins, stop.anchor, floor);
		anchored.push(distance);
		if (distance !== undefined) floor = distance;
	}

	// Seconde passe : les autres, projetés entre le dernier arrêt situé et le prochain arrêt reporté.
	const stops: ItineraryStop[] = [];
	const end = shape.at(-1)?.distance ?? 0;
	let previous = 0;
	for (const [index, stop] of sequence.entries()) {
		let distance = anchored[index];
		if (distance === undefined) {
			const coordinates = provisional.get(stop.stopId) ?? gtfs.stopCoordinates.get(stop.stopId);
			if (coordinates === undefined) continue;
			const ceiling = anchored.slice(index + 1).find((next) => next !== undefined) ?? end;
			const projection = projectOnShape(shape, coordinates, { from: previous, to: ceiling });
			if (projection === undefined) continue;
			distance = Math.min(ceiling, Math.max(previous, projection.distance));
		}
		stops.push({ stopId: stop.stopId, stopSequence: stop.stopSequence, distance });
		previous = distance;
	}

	return { key, shape, stops };
}

/** Une polyligne et l'abscisse curviligne de chacun de ses points, cumulée comme le GTFS statique. */
function withDistances(points: readonly Coordinates[]): ShapePoint[] {
	let distance = 0;
	return points.map((point, index) => {
		const before = points[index - 1];
		if (before !== undefined) distance += haversine(before, point);
		return { latitude: point.latitude, longitude: point.longitude, distance };
	});
}

/**
 * Reporte une abscisse de l'itinéraire d'origine sur le trajet recousu : sur le premier segment,
 * au-delà de `floor`, que le trajet reprend tel quel de l'itinéraire et qui la porte. `undefined`
 * lorsqu'elle tombe dans ce que le trajet a remplacé.
 */
function carry(
	original: readonly ShapePoint[],
	shape: readonly ShapePoint[],
	origins: readonly (number | null)[],
	distance: number,
	floor: number,
): number | undefined {
	for (let index = 0; index < shape.length - 1; index += 1) {
		const from = origins[index];
		const to = origins[index + 1];
		if (from === null || from === undefined || to !== from + 1) continue;

		const start = original[from] as ShapePoint;
		const stop = original[to] as ShapePoint;
		if (distance < start.distance || distance > stop.distance) continue;

		const fraction =
			stop.distance === start.distance ? 0 : (distance - start.distance) / (stop.distance - start.distance);
		const head = shape[index] as ShapePoint;
		const tail = shape[index + 1] as ShapePoint;
		const carried = head.distance + (tail.distance - head.distance) * fraction;
		if (carried >= floor) return carried;
	}
	return undefined;
}
