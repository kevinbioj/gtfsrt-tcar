import GtfsRealtime from "gtfs-realtime-bindings";
import { Temporal } from "temporal-polyfill";

let currentInterval: NodeJS.Timeout | undefined;

export async function useVerificationFeed(resourceUrl: string) {
	const initialResource = await loadResource(resourceUrl);

	const resource = {
		vehicleRoute: initialResource,
		importedAt: Temporal.Now.instant(),
	};

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	currentInterval = setInterval(
		async () => {
			const newResource = await loadResource(resourceUrl);
			resource.vehicleRoute = newResource;
			resource.importedAt = Temporal.Now.instant();
		},
		Temporal.Duration.from({ minutes: 1 }).total("milliseconds"),
	);

	return resource;
}

// --- loadResource

async function loadResource(resourceUrl: string) {
	console.log(`➔ Fetching verification feed at '${resourceUrl}'.`);

	try {
		const vehicleRoute = new Map<string, string>();

		const response = await fetch(resourceUrl);
		if (!response.ok || response.status === 204) {
			console.error(`✘ Failed to fetch verification feed (HTTP ${response.status}).`);
			return vehicleRoute;
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		const feed = GtfsRealtime.transit_realtime.FeedMessage.decode(buffer);

		feed.entity.forEach((entity) => {
			if (!entity.vehicle?.vehicle?.id || !entity.vehicle?.trip?.routeId) {
				return;
			}

			vehicleRoute.set(entity.vehicle.vehicle.id, `TCAR:${entity.vehicle.trip.routeId}`);
		});

		console.log("✓ Successfully loaded resource!");
		return vehicleRoute;
	} catch (cause) {
		throw new Error("Failed to fetch verification feed", { cause });
		// console.log("✘ Failed to load resource!", error);
	}
}
