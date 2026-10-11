/** Ce qu'on retient d'un arrêt d'une course : le dernier horaire que la source en a annoncé. */
export type RememberedStopTime = {
	stopId: string;
	/** Arrivée annoncée, en secondes epoch, `undefined` si la source n'en a donné aucune. */
	arrival?: number;
	/** Départ annoncé, en secondes epoch, `undefined` si la source n'en a donné aucun. */
	departure?: number;
	/** Instant, en secondes epoch, au-delà duquel l'arrêt est oublié. */
	keepUntil: number;
};

/** Les arrêts retenus d'une course, par rang (`stop_sequence`). */
export type RememberedRun = [number, RememberedStopTime][];

/**
 * Le dernier horaire que la source a annoncé pour chaque arrêt de chaque course, d'un relevé à
 * l'autre. La source retire de ses trip updates les arrêts que le véhicule a desservis — et l'ancien
 * GTFS-RT, celui où il se trouve encore. On les lui rend avec ce qu'elle en disait en dernier, soit
 * l'estimation faite juste avant le passage (cf. `backfillStops`).
 *
 * Les courses sont rangées sous leur journée de service (cf. `tripRun`). Un arrêt est oublié passé
 * son `keepUntil`, que l'appelant fixe et que chaque relevé de la course repousse pour tous ses
 * arrêts ; une course, quand elle n'a plus d'arrêt retenu.
 *
 * `restored` rend à la mémoire ce qu'elle tenait au dernier arrêt du producteur (cf. `loadState`) :
 * ce que la source a retiré entre-temps, elle ne le redira pas.
 */
export function useStopTimeMemory(restored: Iterable<readonly [string, RememberedRun]> = []) {
	const runs = new Map<string, Map<number, RememberedStopTime>>(
		[...restored].map(([run, stops]) => [run, new Map(stops)]),
	);

	return {
		/** L'état de la mémoire, tel qu'il sera réécrit sur disque. */
		snapshot(): [string, RememberedRun][] {
			return [...runs].map(([run, stops]) => [run, [...stops]]);
		},

		/** Retient ce que la source annonce des arrêts de la course, par-dessus ce qu'elle en disait. */
		remember(run: string, stops: Iterable<readonly [number, RememberedStopTime]>): void {
			let remembered = runs.get(run);
			if (remembered === undefined) {
				remembered = new Map();
				runs.set(run, remembered);
			}

			// Une course qui prend du retard repousse sa fin : ses arrêts desservis, que la source ne
			// redira plus, doivent tenir jusqu'à elle comme les autres.
			let keepUntil = Number.NEGATIVE_INFINITY;
			for (const [stopSequence, stopTime] of stops) {
				remembered.set(stopSequence, stopTime);
				keepUntil = Math.max(keepUntil, stopTime.keepUntil);
			}
			for (const stopTime of remembered.values()) stopTime.keepUntil = Math.max(stopTime.keepUntil, keepUntil);
		},

		/** Le dernier horaire annoncé pour cet arrêt de la course, `undefined` si on n'en a pas. */
		recall(run: string, stopSequence: number): RememberedStopTime | undefined {
			return runs.get(run)?.get(stopSequence);
		},

		/** Oublie les arrêts dont le `keepUntil` est passé, et les courses qui n'en ont plus. */
		prune(nowSeconds: number): void {
			for (const [run, stops] of runs) {
				for (const [stopSequence, { keepUntil }] of stops) if (keepUntil < nowSeconds) stops.delete(stopSequence);
				if (stops.size === 0) runs.delete(run);
			}
		},
	};
}
