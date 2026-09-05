import { VERIFICATION_STALENESS } from "../config.js";

let currentInterval: NodeJS.Timeout | undefined;

/**
 * Tient à jour un instantané du flux SAE détaillé, une course par véhicule. Il ne sert pas à publier
 * mais à vérifier : c'est la seule source qui porte la girouette du véhicule.
 */
export async function useVehicleMonitoring(url: string, interval: number) {
	const resource = {
		journeys: await loadJourneys(url),
		importedAt: Temporal.Now.instant(),
	};

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	currentInterval = setInterval(async () => {
		const journeys = await loadJourneys(url);
		if (journeys === undefined) return; // échec ponctuel : on garde l'instantané précédent

		resource.journeys = journeys;
		resource.importedAt = Temporal.Now.instant();
	}, interval);

	return resource;
}

async function loadJourneys(url: string): Promise<Map<string, MonitoredJourney> | undefined> {
	console.log("➔ Fetching vehicle monitoring.");

	try {
		const journeys = await fetchVehicleMonitoring(url);
		if (journeys === undefined) return undefined;

		const current = selectCurrentJourneys(journeys);
		console.log(`✓ Loaded ${current.size} monitored journeys.`);
		return current;
	} catch (cause) {
		console.error("✘ Failed to update vehicle monitoring!", cause);
		return undefined;
	}
}

/**
 * Une course active telle que le SAE la publie. La source raisonne par course et non par véhicule :
 * un véhicule au terminus porte deux entrées, celle qu'il termine et celle qu'il entame.
 */
export type MonitoredJourney = {
	/** Numéro de parc, extrait du `VehicleRef` — la clé partagée avec la source de vérité. */
	vehicleId: string;
	tripId: string;
	routeId: string;
	directionId: number;
	/** Quai où le SAE situe le véhicule, toujours desservi par la course annoncée. */
	stopId: string;
	/** Rang de ce quai selon le SAE — pas toujours le `stop_sequence` du GTFS (cf. le métro). */
	stopOrder: number;
	destinationStopId: string;
	/** Girouette du véhicule, abrégée comme sur l'afficheur (« HDV Sotteville »). */
	destinationName: string;
	/** Instant du relevé, en secondes epoch. */
	recordedAt: number;
	position: { latitude: number; longitude: number; bearing: number };
	monitored: boolean;
};

/** Une entrée du flux `vehicle-monitoring`, réduite aux champs exploités. */
type VehicleMonitoringRecord = {
	VehicleRef?: string;
	VJourneyRef?: string;
	LineRef?: string;
	Direction?: number;
	StopPointRef?: string;
	StopPointOrder?: number;
	DestinationRef?: string;
	DestinationName?: string;
	RecordedAtTime?: string;
	Latitude?: number;
	Longitude?: number;
	Bearing?: number;
	IsMonitored?: boolean;
};

/**
 * Dernière version connue du flux et sa date de publication. La source ne compresse pas ses 190 Ko
 * de JSON, mais elle date ses versions et répond 304 : sur un poll toutes les vingt secondes, une
 * bonne partie des requêtes se règle ainsi sans transférer un octet.
 */
let lastModified: string | undefined;
let lastJourneys: MonitoredJourney[] | undefined;

async function fetchVehicleMonitoring(url: string): Promise<MonitoredJourney[] | undefined> {
	// L'ETag de la source vaut « * », qui satisferait n'importe quel If-None-Match et figerait le
	// flux : seule la date de publication est exploitable.
	const response = await fetch(url, {
		headers: lastModified !== undefined && lastJourneys !== undefined ? { "if-modified-since": lastModified } : {},
	});

	if (response.status === 304 && lastJourneys !== undefined) {
		return keepFresh(lastJourneys);
	}

	if (!response.ok || response.status === 204) {
		console.error(`✘ Vehicle monitoring fetch failed (HTTP ${response.status}).`);
		return undefined;
	}

	const records = (await response.json()) as VehicleMonitoringRecord[];
	if (!Array.isArray(records)) {
		console.error("✘ Vehicle monitoring did not return a list.");
		return undefined;
	}

	const journeys: MonitoredJourney[] = [];
	for (const record of records) {
		const journey = toJourney(record);
		if (journey !== undefined) journeys.push(journey);
	}

	lastJourneys = journeys;
	lastModified = response.headers.get("last-modified") ?? undefined;

	return keepFresh(journeys);
}

/**
 * Ne garde qu'une course par véhicule : la plus fraîchement relevée. À fraîcheur égale — deux
 * courses relevées dans la même seconde au terminus —, on préfère celle que le SAE dit suivre, puis
 * celle qui est la moins avancée, c'est-à-dire celle qui commence.
 */
function selectCurrentJourneys(journeys: MonitoredJourney[]): Map<string, MonitoredJourney> {
	const current = new Map<string, MonitoredJourney>();

	for (const journey of journeys) {
		const previous = current.get(journey.vehicleId);
		if (previous === undefined || outranks(journey, previous)) {
			current.set(journey.vehicleId, journey);
		}
	}

	return current;
}

// ---

/**
 * Écarte les relevés périmés. Le filtre est réappliqué à chaque poll, y compris quand la source a
 * répondu 304 : une version qui cesse d'être republiée doit finir par cesser d'être diffusée.
 *
 * La source élague déjà les siens au bout d'un quart d'heure environ ; le garde-fou vaut surtout
 * pour le jour où elle se met à traîner des courses terminées.
 */
function keepFresh(journeys: MonitoredJourney[]): MonitoredJourney[] {
	const nowSeconds = Math.floor(Date.now() / 1000);
	return journeys.filter((journey) => nowSeconds - journey.recordedAt <= VERIFICATION_STALENESS);
}

function outranks(journey: MonitoredJourney, previous: MonitoredJourney): boolean {
	if (journey.recordedAt !== previous.recordedAt) return journey.recordedAt > previous.recordedAt;
	if (journey.monitored !== previous.monitored) return journey.monitored;
	return journey.stopOrder < previous.stopOrder;
}

function toJourney(record: VehicleMonitoringRecord): MonitoredJourney | undefined {
	// « TCAR:Vehicle::3121:LOC » → « 3121 », le numéro de parc que publie aussi la source de vérité.
	const vehicleId = record.VehicleRef?.split(":")[3];
	if (!vehicleId || !record.VJourneyRef || !record.LineRef || !record.StopPointRef) return undefined;

	const recordedAt = toEpochSeconds(record.RecordedAtTime);
	if (recordedAt === undefined) return undefined;

	if (typeof record.Latitude !== "number" || typeof record.Longitude !== "number") return undefined;

	return {
		vehicleId,
		tripId: `TCAR:${record.VJourneyRef}`,
		routeId: `TCAR:${record.LineRef}`,
		// Le SAE numérote ses sens à partir de 1, le GTFS à partir de 0.
		directionId: (record.Direction ?? 1) - 1,
		stopId: `TCAR:${record.StopPointRef}`,
		stopOrder: record.StopPointOrder ?? 0,
		destinationStopId: record.DestinationRef ? `TCAR:${record.DestinationRef}` : "",
		destinationName: record.DestinationName ?? "",
		recordedAt,
		position: {
			latitude: record.Latitude,
			longitude: record.Longitude,
			bearing: record.Bearing ?? 0,
		},
		monitored: record.IsMonitored === true,
	};
}

/**
 * Les horodatages de la source sont des dates locales sans fuseau (« 2026-09-05T07:56:53 ») : les
 * lire brutes les décalerait de l'offset parisien.
 */
function toEpochSeconds(value: string | undefined): number | undefined {
	if (!value) return undefined;

	try {
		return Math.floor(Temporal.PlainDateTime.from(value).toZonedDateTime("Europe/Paris").epochMilliseconds / 1000);
	} catch {
		return undefined;
	}
}
