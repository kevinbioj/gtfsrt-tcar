import GtfsRealtime from "gtfs-realtime-bindings";

import { POLL_INTERVAL, VEHICLE_STALENESS } from "../config.js";

export type RelayedNetwork = {
	provider: string;
	tripUpdatesUrl: string;
	vehiclePositionsUrl: string;
	/** Le champ du descripteur de véhicule qui porte le numéro de parc. */
	vehicleNumber: "id" | "label";
};

/** Les trip updates d'un réseau relayé, identifiants préfixés comme ceux du GTFS. */
export type RelayedTripUpdates = { network: string; tripUpdates: GtfsRealtime.transit_realtime.ITripUpdate[] };

/**
 * Relaie le temps réel des réseaux voisins (cf. `RELAYED_NETWORKS`). Chaque relevé remplace le
 * précédent, flux par flux : un échec ponctuel laisse en place ce qu'on savait, et les positions qui
 * vieillissent sortent d'elles-mêmes du feed à la lecture.
 *
 * Les positions sortent telles quelles. Les trip updates, eux, passent ensuite par le même traitement
 * que ceux de TCAR — journée de service, annulations, arrêts supprimés — qui les remanie en place :
 * c'est pourquoi on garde le flux brut, et qu'on en redonne une copie neuve à chaque lecture. Une
 * annulation levée entre-temps ne doit rien avoir effacé de ce que la source annonçait.
 */
export function useRelayedNetworks(networks: readonly RelayedNetwork[]) {
	const tripFeeds = new Map<string, Uint8Array>();
	const vehiclePositions = new Map<string, Map<string, GtfsRealtime.transit_realtime.IVehiclePosition>>();

	async function poll() {
		await Promise.all(
			networks.map(async (network) => {
				const { provider, tripUpdatesUrl, vehiclePositionsUrl } = network;
				const [tripFeed, vehicleFeed] = await Promise.all([
					loadFeed(provider, "trip updates", tripUpdatesUrl),
					loadFeed(provider, "vehicle positions", vehiclePositionsUrl),
				]);

				if (tripFeed !== undefined) tripFeeds.set(provider, tripFeed);
				if (vehicleFeed !== undefined) {
					vehiclePositions.set(provider, relayVehiclePositions(network, decode(vehicleFeed)));
				}

				console.log(`✓ ${provider}: ${vehiclePositions.get(provider)?.size ?? 0} vehicle positions.`);
			}),
		);
	}

	setInterval(poll, POLL_INTERVAL);
	void poll();

	return {
		/** Les trip updates de chaque réseau relayé, dans une copie que l'appelant peut remanier. */
		tripUpdates(): RelayedTripUpdates[] {
			return networks.flatMap((network) => {
				const feed = tripFeeds.get(network.provider);
				return feed === undefined
					? []
					: [{ network: network.provider, tripUpdates: relayTripUpdates(network, decode(feed)) }];
			});
		},

		/** Les positions de tous les réseaux relayés, hormis celles que la source a cessé de réhorodater. */
		vehiclePositions(nowSeconds: number): Map<string, GtfsRealtime.transit_realtime.IVehiclePosition> {
			return new Map(
				[...vehiclePositions.values()]
					.flatMap((entries) => [...entries])
					.filter(([, vehicle]) => nowSeconds - Number(vehicle.timestamp ?? 0) <= VEHICLE_STALENESS),
			);
		},
	};
}

// ---

async function loadFeed(provider: string, label: string, url: string) {
	try {
		const response = await fetch(url);
		if (!response.ok || response.status === 204) {
			console.error(`✘ ${provider} ${label} fetch failed (HTTP ${response.status}).`);
			return undefined;
		}

		const bytes = new Uint8Array(await response.arrayBuffer());
		decode(bytes); // un flux illisible est un échec comme un autre : on garde le précédent
		return bytes;
	} catch (cause) {
		console.error(`✘ ${provider} ${label} poll error:`, cause);
		return undefined;
	}
}

function decode(bytes: Uint8Array) {
	return GtfsRealtime.transit_realtime.FeedMessage.decode(bytes);
}

/** L'identifiant, préfixé du réseau quand la source l'omet (« 307 » → « TNI:307 »). */
function withPrefix(provider: string, id: string): string {
	return id.startsWith(`${provider}:`) ? id : `${provider}:${id}`;
}

/**
 * Le numéro de parc du véhicule, lu dans le champ que déclare le réseau et débarrassé du préfixe que
 * certaines sources y collent (« TAE802 » → « 802 ») : c'est le réseau qui préfixe, à la publication,
 * comme pour TCAR. `undefined` quand la source ne le donne pas.
 */
function vehicleNumber(
	{ provider, vehicleNumber }: RelayedNetwork,
	descriptor: GtfsRealtime.transit_realtime.IVehicleDescriptor | null | undefined,
): string | undefined {
	const raw = descriptor?.[vehicleNumber];
	if (!raw) return undefined;
	return raw.startsWith(provider) ? raw.slice(provider.length).replace(/^:/, "") : raw;
}

/** Préfixe la course et la ligne du descripteur. */
function prefixTrip(provider: string, trip: GtfsRealtime.transit_realtime.ITripDescriptor) {
	if (trip.tripId) trip.tripId = withPrefix(provider, trip.tripId);
	if (trip.routeId) trip.routeId = withPrefix(provider, trip.routeId);
}

function relayTripUpdates(network: RelayedNetwork, feed: GtfsRealtime.transit_realtime.FeedMessage) {
	const { provider } = network;
	const relayed: GtfsRealtime.transit_realtime.ITripUpdate[] = [];

	for (const entity of feed.entity) {
		const tripUpdate = entity.tripUpdate;
		if (!tripUpdate?.trip?.tripId) continue;

		prefixTrip(provider, tripUpdate.trip);
		for (const stopTimeUpdate of tripUpdate.stopTimeUpdate ?? []) {
			if (stopTimeUpdate.stopId) stopTimeUpdate.stopId = withPrefix(provider, stopTimeUpdate.stopId);
		}

		// Seul le numéro de parc survit, sous la forme qu'il prend dans les positions.
		const number = vehicleNumber(network, tripUpdate.vehicle);
		tripUpdate.vehicle = number === undefined ? undefined : { id: `${provider}:${number}` };

		relayed.push(tripUpdate);
	}

	return relayed;
}

function relayVehiclePositions(network: RelayedNetwork, feed: GtfsRealtime.transit_realtime.FeedMessage) {
	const { provider } = network;
	const relayed = new Map<string, GtfsRealtime.transit_realtime.IVehiclePosition>();

	for (const entity of feed.entity) {
		const vehicle = entity.vehicle;
		const number = vehicleNumber(network, vehicle?.vehicle);
		if (!vehicle || number === undefined || !vehicle.position) continue;

		if (vehicle.trip) prefixTrip(provider, vehicle.trip);
		if (vehicle.stopId) vehicle.stopId = withPrefix(provider, vehicle.stopId);
		vehicle.vehicle = { id: `${provider}:${number}` };

		relayed.set(`VM:${provider}:${number}`, vehicle);
	}

	return relayed;
}
