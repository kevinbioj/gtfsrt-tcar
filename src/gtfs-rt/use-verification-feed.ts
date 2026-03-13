import GtfsRealtime from "gtfs-realtime-bindings";
import { Temporal } from "temporal-polyfill";

let currentInterval: NodeJS.Timeout | undefined;

export async function useVerificationFeed(resourceUrl: string) {
	const initialResource = await loadResource(resourceUrl);

	const resource = {
		verifiedVehicles: initialResource,
		importedAt: Temporal.Now.instant(),
	};

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	currentInterval = setInterval(
		async () => {
			const newResource = await loadResource(resourceUrl);
			resource.verifiedVehicles = newResource;
			resource.importedAt = Temporal.Now.instant();
		},
		Temporal.Duration.from({ minutes: 1 }).total("milliseconds"),
	);

	return resource;
}

// --- loadResource

export type VerifiedVehicle = {
	position: {
		latitude: number;
		longitude: number;
		bearing: number;
	};
	recordedAt: number;
	routeId: string;
};

async function loadResource(resourceUrl: string) {
	console.log(`➔ Fetching verification feed at '${resourceUrl}'.`);

	try {
		const verifiedVehicles = new Map<string, VerifiedVehicle>();

		const response = await fetch(resourceUrl);
		if (!response.ok || response.status === 204) {
			console.error(`✘ Failed to fetch verification feed (HTTP ${response.status}).`);
			return verifiedVehicles;
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		const feed = GtfsRealtime.transit_realtime.FeedMessage.decode(buffer);

		const now = Temporal.Now.instant();
		const offsetSeconds = Math.floor(now.toZonedDateTimeISO("Europe/Paris").offsetNanoseconds / 1_000_000_000);
		if (now.since(Temporal.Instant.fromEpochMilliseconds(+feed.header.timestamp! * 1000)).total("minutes") >= 30) {
			return verifiedVehicles;
		}

		feed.entity.forEach((entity) => {
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
				recordedAt: Math.floor(+entity.vehicle.timestamp! / 1000),
				routeId: `TCAR:${entity.vehicle.trip.routeId}`,
			});
		});

		console.log("✓ Successfully loaded resource!");
		return verifiedVehicles;
	} catch (cause) {
		// throw new Error("Failed to fetch verification feed", { cause });
		console.log("✘ Failed to update verification feed!", cause);
	}
}
