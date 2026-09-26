import type { AlertPeriod } from "../ai/analyze-alert.js";
import { type AnalyzedAlert, type CancelIndex, isActive, type SkipIndex } from "../gtfs-rt/use-service-alerts.js";
import { courseKey, type OrderedStop, type StaticGtfs } from "../gtfs-rt/use-static-gtfs.js";
import { type DetourStore, type Modification, type ModificationOrigin, type Proposal, scopeKey } from "./store.js";

/**
 * Une modification telle que tout le reste la voit : ce qui a été saisi, et, pour chaque champ laissé
 * vide d'une modification rattachée, ce qu'en dit son info trafic.
 */
export type ResolvedModification = {
	uid: number;
	origin: ModificationOrigin;
	/** L'identifiant d'entité de l'info trafic, que porte `serviceAlertId` ; `null` sans info trafic. */
	alertId: string | null;
	alertNumber: string | null;
	/** Le titre de l'info trafic, ou `null` sans info trafic. */
	alertHeader: string | null;
	/** Le texte de l'info trafic, en HTML brut ; vide sans info trafic. */
	alertDescription: string;
	/** La raison saisie, sinon le titre de l'info trafic. */
	label: string;
	routeId: string;
	directionId: number;
	/** Les tracés visés, ou aucun pour tous. */
	patternIds: string[];
	/** La période saisie, sinon celles de l'info trafic. */
	periods: AlertPeriod[];
	/** Vrai lorsque l'une des périodes couvre l'instant de l'indexation. */
	active: boolean;
	disabled: boolean;
	/** Les quais supprimés : saisis, sinon ceux que l'analyse lit pour la ligne et le sens. */
	removedStopIds: Set<string>;
	/** Vrai lorsque les arrêts supprimés sont ceux de l'analyse, faute d'avoir été saisis. */
	removedFromAnalysis: boolean;
	/** Ce que l'analyse lit pour la ligne et le sens, saisi ou non — vide sans info trafic. */
	analysisStopIds: Set<string>;
	/** Première apparition de l'info trafic, ou création de la modification : l'ordre chronologique. */
	firstSeenAt: number;
	/** Ce qui a été saisi, tel quel. */
	record: Modification;
};

/**
 * Un trio info trafic × ligne × sens où l'IA n'a rien à appliquer : la ligne est citée sans arrêt
 * supprimé lu, ou les arrêts lus ne sont pas desservis dans ce sens.
 */
export type Suggestion = {
	/** {@link scopeKey} du trio. */
	key: string;
	alertId: string | null;
	alertNumber: string;
	alertHeader: string;
	routeId: string;
	directionId: number;
	/** Les quais que l'analyse lit supprimés, s'il y en a. */
	removedStopIds: string[];
	periods: AlertPeriod[];
	active: boolean;
	firstSeenAt: number;
};

export type ModificationIndex = ReturnType<typeof useModificationIndex>;

/**
 * Les modifications résolues, les suggestions, et les arrêts à sauter — rebâtis d'un bloc.
 *
 * `reindex` est purement local : il relit la dernière analyse et la base, sans toucher au réseau ni
 * rappeler l'IA. Il se rejoue donc à chaque relevé d'infos trafic comme après chaque saisie, et c'est
 * lui qui crée au passage les modifications que l'analyse permet d'appliquer.
 */
export function useModificationIndex(
	store: DetourStore,
	gtfs: { data: StaticGtfs },
	alerts: () => readonly AnalyzedAlert[],
) {
	const resource = {
		/** Les modifications affichées et publiables, par uid. */
		modifications: new Map<number, ResolvedModification>(),
		/** Les trios à accepter ou à ignorer. */
		suggestions: [] as Suggestion[],
		/** Les modifications saisies dont l'info trafic a quitté le flux : à rattacher, ou à supprimer. */
		orphans: [] as Modification[],
		/** Les quais à sauter dans les trip updates. */
		skipIndex: new Map() as SkipIndex,
		/** Les courses à annuler, par clé de course. */
		cancelIndex: new Map() as CancelIndex,
		reindex() {
			const now = Temporal.Now.instant();
			const nowSeconds = Math.floor(now.epochMilliseconds / 1000);
			const current = alerts();

			store.recordAlerts(current, nowSeconds);

			const reading = readAnalysis(current, gtfs.data);
			store.syncAi(reading.proposals, nowSeconds);

			const indexed = indexModifications(current, reading, store, now);
			resource.modifications = indexed.modifications;
			resource.suggestions = indexed.suggestions;
			resource.orphans = indexed.orphans;
			resource.skipIndex = indexed.skipIndex;
			resource.cancelIndex = indexed.cancelIndex;
		},
	};

	resource.reindex();
	return resource;
}

// ---

/** Ce que l'analyse dit, trio par trio : les arrêts lus, et ce que l'IA crée ou suggère. */
type Reading = {
	/** {@link scopeKey} → quais que l'analyse lit supprimés. */
	removed: Map<string, Set<string>>;
	/** Les modifications que l'IA crée d'elle-même. */
	proposals: Proposal[];
	/** Les trios qu'elle ne sait pas trancher, par {@link scopeKey}. */
	undecided: Map<string, { alert: AnalyzedAlert; routeId: string; directionId: number }>;
};

/**
 * Trie les trios de chaque info trafic : ceux que l'IA crée, ceux qu'elle suggère.
 *
 * Elle crée dès que l'analyse lit, dans ce sens, des arrêts supprimés que la ligne y dessert : une
 * modification par LECTURE de ces arrêts — les mêmes suites supprimées, encadrées des mêmes arrêts
 * juste avant et juste après. Quand tous les tracés qui en desservent les lisent pareil, il n'y en a
 * qu'une, qui les vise tous ; sinon — la 305 qui file après l'Hôtel de Ville vers deux arrêts
 * différents, un service partiel qui commence au milieu des arrêts supprimés — une par lecture, qui ne
 * vise que ses tracés, et dont les tronçons se dessinent alors juste.
 *
 * Reste suggéré ce qui n'a rien à appliquer : une ligne citée sans aucun arrêt lu dans un sens, ou
 * des arrêts lus que la ligne n'y dessert pas. L'info trafic la concerne peut-être, sans que le texte
 * dise comment.
 */
function readAnalysis(alerts: readonly AnalyzedAlert[], gtfs: StaticGtfs): Reading {
	const removed = new Map<string, Set<string>>();
	const proposals: Proposal[] = [];
	const undecided: Reading["undecided"] = new Map();

	for (const alert of alerts) {
		for (const { routeId, directionId, stopIds } of alert.contributions) {
			// Un bucket « les deux sens » se dédouble : la maille d'une modification est le sens.
			for (const direction of directionId === null ? [0, 1] : [directionId]) {
				const key = scopeKey(alert.alertNumber, routeId, direction);
				const set = removed.get(key) ?? new Set<string>();
				for (const stopId of stopIds) set.add(stopId);
				removed.set(key, set);
			}
		}

		for (const routeId of alert.routeIds) {
			for (const { directionId } of gtfs.routeDirections.get(routeId) ?? []) {
				const key = scopeKey(alert.alertNumber, routeId, directionId);
				const readings = readingsOf(gtfs, routeId, directionId, removed.get(key) ?? new Set());
				if (readings.length === 0) {
					undecided.set(key, { alert, routeId, directionId });
					continue;
				}
				for (const patternIds of readings) {
					proposals.push({
						alertNumber: alert.alertNumber,
						routeId,
						directionId,
						patternIds: readings.length === 1 ? [] : patternIds,
					});
				}
			}
		}
	}

	return { removed, proposals, undecided };
}

/**
 * Les tracés du sens qui desservent des arrêts supprimés, groupés par façon de les lire. Aucun
 * groupe si aucun n'en dessert : l'analyse n'a rien lu, ou des arrêts que la ligne ne porte pas ici.
 */
function readingsOf(gtfs: StaticGtfs, routeId: string, directionId: number, removed: ReadonlySet<string>): string[][] {
	const readings = new Map<string, string[]>();
	for (const pattern of gtfs.routePatterns.get(routeId)?.get(directionId) ?? []) {
		if (!pattern.stops.some((stop) => removed.has(stop.stopId))) continue;
		const reading = runsOf(pattern.stops, removed);
		const patternIds = readings.get(reading) ?? [];
		patternIds.push(pattern.patternId);
		readings.set(reading, patternIds);
	}
	return [...readings.values()];
}

/**
 * Les suites d'arrêts supprimés d'un tracé, chacune encadrée de l'arrêt qui la précède et de celui
 * qui la suit — « ^ » et « $ » quand la suite ouvre ou ferme le tracé.
 */
function runsOf(stops: readonly OrderedStop[], removed: ReadonlySet<string>): string {
	const runs: string[] = [];
	let index = 0;

	while (index < stops.length) {
		if (!removed.has((stops[index] as OrderedStop).stopId)) {
			index += 1;
			continue;
		}

		let end = index;
		while (end < stops.length && removed.has((stops[end] as OrderedStop).stopId)) end += 1;

		const before = stops[index - 1]?.stopId ?? "^";
		const after = stops[end]?.stopId ?? "$";
		const run = stops.slice(index, end).map((stop) => stop.stopId);
		runs.push(`${before}(${run.join(",")})${after}`);
		index = end;
	}

	return runs.join(";");
}

/**
 * Résout les modifications, et en tire les suggestions et les arrêts à sauter.
 *
 * Une modification rattachée à une info trafic qui n'est plus au flux reste en base, mais n'a plus
 * de perturbation à porter : elle n'est pas publiée — les travaux reprennent souvent, et le numéro
 * avec eux. Si elle porte une saisie, elle est mise de côté : le réseau remplace souvent une info
 * trafic par une autre, sous un autre numéro, avant la fin de la perturbation (« reprise du parcours
 * le … »), et ce qui a été saisi se rattache alors à la nouvelle plutôt que de se refaire.
 */
function indexModifications(
	alerts: readonly AnalyzedAlert[],
	reading: Reading,
	store: DetourStore,
	now: Temporal.Instant,
) {
	const byNumber = new Map(alerts.map((alert) => [alert.alertNumber, alert]));
	const modifications = new Map<number, ResolvedModification>();
	const skipIndex: SkipIndex = new Map();
	const cancelIndex: CancelIndex = new Map();
	/** Les trios qui portent une modification : ils ne se suggèrent plus. */
	const covered = new Set<string>();
	const orphans: Modification[] = [];

	for (const record of store.modifications.values()) {
		const alert = record.alertNumber === null ? undefined : byNumber.get(record.alertNumber);
		if (record.alertNumber !== null && alert === undefined) {
			if (hasInput(record)) orphans.push(record);
			continue;
		}

		const key = alert === undefined ? null : scopeKey(alert.alertNumber, record.routeId, record.directionId);
		if (key !== null) covered.add(key);

		const periods: AlertPeriod[] =
			record.period !== null
				? [{ start: record.period.start, end: record.period.end, dailyWindow: null }]
				: (alert?.periods ?? []);
		const analysisStopIds = new Set(key === null ? [] : (reading.removed.get(key) ?? []));
		const removedStopIds = record.removedStopIds !== null ? new Set(record.removedStopIds) : analysisStopIds;
		const active = isActive(periods, now);

		modifications.set(record.uid, {
			uid: record.uid,
			origin: record.origin,
			alertId: alert?.alertId ?? null,
			alertNumber: record.alertNumber,
			alertHeader: alert?.headerText ?? null,
			alertDescription: alert?.descriptionText ?? "",
			label: record.label ?? alert?.headerText ?? "",
			routeId: record.routeId,
			directionId: record.directionId,
			patternIds: record.patternIds,
			periods,
			active,
			disabled: record.disabled,
			removedStopIds,
			removedFromAnalysis: record.removedStopIds === null,
			analysisStopIds,
			firstSeenAt:
				record.alertNumber === null
					? record.createdAt
					: (store.alertFirstSeen.get(record.alertNumber) ?? record.createdAt),
			record,
		});

		// Invisible ou hors période, elle ne fait rien sauter.
		if (active && !record.disabled && removedStopIds.size > 0) {
			const buckets = skipIndex.get(record.routeId) ?? [];
			buckets.push({
				directionId: record.directionId,
				patternIds: record.patternIds.length === 0 ? null : new Set(record.patternIds),
				stopIds: removedStopIds,
			});
			skipIndex.set(record.routeId, buckets);
		}

		// Les annulations, elles, ne se jaugent pas maintenant mais course par course, à son départ
		// (cf. `isCancelled`) : seule l'invisibilité les écarte d'emblée.
		if (!record.disabled) {
			const entry = { patternIds: record.patternIds.length === 0 ? null : new Set(record.patternIds), periods };
			for (const { stopId, departure } of record.cancelledDepartures) {
				const key = courseKey(record.routeId, record.directionId, stopId, departure);
				const entries = cancelIndex.get(key) ?? [];
				entries.push(entry);
				cancelIndex.set(key, entries);
			}
		}
	}

	const suggestions: Suggestion[] = [];
	for (const [key, { alert, routeId, directionId }] of reading.undecided) {
		if (covered.has(key) || store.dismissedScopes.has(key)) continue;

		suggestions.push({
			key,
			alertId: alert.alertId,
			alertNumber: alert.alertNumber,
			alertHeader: alert.headerText,
			routeId,
			directionId,
			removedStopIds: [...(reading.removed.get(key) ?? [])],
			periods: alert.periods,
			active: isActive(alert.periods, now),
			firstSeenAt: store.alertFirstSeen.get(alert.alertNumber) ?? Math.floor(now.epochMilliseconds / 1000),
		});
	}

	console.log(
		`✓ ${modifications.size} modifications indexed (${skipIndex.size} routes with skipped stops, ${cancelIndex.size} cancelled departures, ${suggestions.length} suggestions).`,
	);

	return { modifications, suggestions, orphans, skipIndex, cancelIndex };
}

/**
 * La modification porte-t-elle quelque chose que l'info trafic ne redonnerait pas ? Sans rien de
 * saisi, elle n'est que ce que l'analyse de la nouvelle info trafic recrée d'elle-même.
 */
function hasInput(record: Modification): boolean {
	return (
		record.segments.length > 0 ||
		record.cancelledDepartures.length > 0 ||
		record.label !== null ||
		record.period !== null ||
		record.removedStopIds !== null
	);
}
