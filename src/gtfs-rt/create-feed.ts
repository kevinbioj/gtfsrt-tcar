import GtfsRealtime from "gtfs-realtime-bindings";

export function createFeed(
	tripUpdates: Map<string, GtfsRealtime.transit_realtime.ITripUpdate> | null,
	vehiclePositions: Map<string, GtfsRealtime.transit_realtime.IVehiclePosition> | null,
	/**
	 * Les entités des déviations déclarées — arrêts provisoires, tracés, modifications de course. Déjà
	 * assemblées et ordonnées (cf. `buildDetourEntities`) : elles accompagnent les trip updates, dont
	 * elles disent ce que les arrêts supprimés ne disent pas — par où passe le véhicule à la place.
	 */
	detourEntities: readonly GtfsRealtime.transit_realtime.IFeedEntity[] | null = null,
) {
	return GtfsRealtime.transit_realtime.FeedMessage.create({
		header: {
			gtfsRealtimeVersion: "2.0",
			incrementality: GtfsRealtime.transit_realtime.FeedHeader.Incrementality.FULL_DATASET,
			timestamp: Math.floor(Temporal.Now.instant().epochMilliseconds / 1000),
		},
		entity: [
			...(tripUpdates !== null
				? tripUpdates
						.entries()
						.flatMap(([id, tripUpdate]) => (tripUpdate.stopTimeUpdate?.length ? [{ id, tripUpdate }] : []))
						.toArray()
				: []),
			...(vehiclePositions !== null
				? vehiclePositions
						.entries()
						.map(([id, vehicle]) => ({ id, vehicle }))
						.toArray()
				: []),
			...(detourEntities ?? []),
		],
	});
}
