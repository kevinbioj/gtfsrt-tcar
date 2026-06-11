import GtfsRealtime from "gtfs-realtime-bindings";

let currentInterval: NodeJS.Timeout | undefined;

export async function useVerificationFeed(vehicleUrl: string) {
	const initialResource = await loadResource(vehicleUrl);

	const resource = {
		verifiedVehicles: initialResource,
		importedAt: Temporal.Now.instant(),
	};

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	currentInterval = setInterval(
		async () => {
			const newResource = await loadResource(vehicleUrl);
			resource.verifiedVehicles = newResource;
			resource.importedAt = Temporal.Now.instant();
		},
		Temporal.Duration.from({ minutes: 1 }).total("milliseconds"),
	);

	return resource;
}

// ---

export type VerifiedVehicle = {
	position: {
		latitude: number;
		longitude: number;
		bearing: number;
	};
	recordedAt: number;
	routeId: string;
	directionId: number;
};

async function loadResource(vehicleUrl: string) {
	console.log("➔ Fetching verification feed.");

	try {
		const verifiedVehicles = new Map<string, VerifiedVehicle>();

		const vehicleResponse = await fetch(vehicleUrl);
		if (!vehicleResponse.ok || vehicleResponse.status === 204) {
			console.error(`✘ Failed to fetch verification feed (HTTP ${vehicleResponse.status}).`);
			return verifiedVehicles;
		}

		const vehicleBuffer = Buffer.from(await vehicleResponse.arrayBuffer());
		const vehicleFeed = GtfsRealtime.transit_realtime.FeedMessage.decode(vehicleBuffer);

		const now = Temporal.Now.instant();
		const offsetSeconds = Math.floor(now.toZonedDateTimeISO("Europe/Paris").offsetNanoseconds / 1_000_000_000);

		if (
			now.since(Temporal.Instant.fromEpochMilliseconds(+vehicleFeed.header.timestamp! * 1000)).total("minutes") >= 30
		) {
			return verifiedVehicles;
		}

		vehicleFeed.entity.forEach((entity) => {
			const timestamp = +entity.vehicle!.timestamp! + offsetSeconds;

			if (
				!entity.vehicle?.vehicle?.id ||
				!entity.vehicle?.trip?.routeId ||
				now.since(Temporal.Instant.fromEpochMilliseconds(timestamp * 1000)).total("minutes") >= 30
			) {
				return;
			}

			verifiedVehicles.set(entity.vehicle.vehicle.id, {
				position: {
					latitude: entity.vehicle.position!.latitude,
					longitude: entity.vehicle.position!.longitude,
					bearing: entity.vehicle.position!.bearing!,
				},
				recordedAt: timestamp,
				routeId: `TCAR:${entity.vehicle.trip.routeId}`,
				directionId: entity.vehicle.trip.directionId ?? 0,
			});
		});

		console.log(`✓ Loaded ${verifiedVehicles.size} verified vehicles.`);
		return verifiedVehicles;
	} catch (cause) {
		console.error("✘ Failed to update verification feed!", cause);
	}
}
