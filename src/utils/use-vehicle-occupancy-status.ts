import GtfsRealtime from "gtfs-realtime-bindings";
import { Temporal } from "temporal-polyfill";
import { match } from "ts-pattern";

import { VEHICLE_OCCUPANCY_STALENESS, VEHICLE_OCCUPANCY_STATUS_URL } from "../config.js";

type VehicleOccupancyStatus = {
	recordedAt: number;
	status: GtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus;
};

export function useVehicleOccupancyStatuses() {
	const vehicleOccupancyStatuses = new Map<string, VehicleOccupancyStatus>();

	updateVehicleOccupancyStatuses(vehicleOccupancyStatuses);
	setInterval(
		async () => {
			await updateVehicleOccupancyStatuses(vehicleOccupancyStatuses);

			const now = Date.now();
			vehicleOccupancyStatuses.forEach(({ recordedAt }, id) => {
				if (now - recordedAt > VEHICLE_OCCUPANCY_STALENESS) {
					vehicleOccupancyStatuses.delete(id);
				}
			});
		},
		Temporal.Duration.from({ seconds: 30 }).total("milliseconds"),
	);

	return vehicleOccupancyStatuses;
}

// ---

async function updateVehicleOccupancyStatuses(vehicleOccupancyStatuses: Map<string, VehicleOccupancyStatus>) {
	console.log(`➔ Fetching vehicle occupancy statuses.`);

	try {
		const response = await fetch(VEHICLE_OCCUPANCY_STATUS_URL);
		if (!response.ok) {
			throw new Error(`Failed to fetch vehicle occupancy statuses (HTTP ${response.status})`);
		}

		const now = Date.now();

		const html = await response.text();
		const relevantContent = html.slice(
			html.indexOf('<script type="text/javascript">vehicles.'),
			html.indexOf("positions.addTo(myMap);</script>"),
		);
		const lines = relevantContent.split(/\r?\n/g);

		for (const line of lines) {
			const matchResult = /<b>(\d+)<\/b>.*\( (\d{3,4}) \)/.exec(line);
			if (matchResult === null) {
				continue;
			}

			const [, vehicleId, vehicleNumber] = matchResult;

			const loadLine = lines.find((l) => l.includes(`${vehicleId}_load`));
			if (loadLine === undefined) {
				continue;
			}

			const backgroundColorIndex = loadLine.indexOf("background-color:#");
			const backgroundColor = loadLine.slice(backgroundColorIndex + 18, backgroundColorIndex + 24);

			vehicleOccupancyStatuses.set(vehicleNumber, {
				recordedAt: now,
				status: match(backgroundColor)
					.with("1cc88a", () => GtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.MANY_SEATS_AVAILABLE)
					.with("f6c23e", () => GtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.FEW_SEATS_AVAILABLE)
					.with("e74a3b", () => GtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.FULL)
					.otherwise(() => GtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.NO_DATA_AVAILABLE),
			});
		}

		console.log(`✓ Done fetching vehicle occupancy statuses.`);
	} catch (cause) {
		console.error(`✘ Failed to fetch vehicle occupancy statuses`, cause);
	}
}
