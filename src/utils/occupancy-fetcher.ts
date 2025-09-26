import type { OccupancyStatus } from "../types/gtfs-rt.js";

const url = Buffer.from(
	"aHR0cHM6Ly90Y2FyLmZsb3dseS5yZS9Qb3J0YWwvTWFwRGV2aWNlcy5hc3B4",
	"base64",
).toString("utf-8");

const levels: Record<string, OccupancyStatus> = {
	"1cc88a": "MANY_SEATS_AVAILABLE",
	f6c23e: "FEW_SEATS_AVAILABLE",
	e74a3b: "FULL",
};

let cached: string[] | undefined;
let lastFetchAt: number | undefined;

const vehicleCache = new Map<
	string,
	{ status: OccupancyStatus; recordedAt: number }
>();

const getFromCache = (vehicleNumber: string) => {
	const cached = vehicleCache.get(vehicleNumber);
	if (
		typeof cached === "undefined" ||
		Date.now() - cached.recordedAt > 60_000 * 5
	)
		return;
	return cached.status;
};

export async function getVehicleOccupancyStatus(vehicleNumber: string) {
	if (typeof lastFetchAt === "undefined" || Date.now() - lastFetchAt > 30_000) {
		lastFetchAt = Date.now();
		cached = await fetch(url)
			.then((response) => response.text())
			.then((document) => {
				const startBoundary = document.indexOf(
					'<script type="text/javascript">vehicles.',
				);
				const endBoundary = document.indexOf(
					"positions.addTo(myMap);</script>",
				);
				return document.slice(startBoundary, endBoundary).split(/\r?\n/);
			})
			.catch((cause) => {
				const error = new Error("Failed to fetch vehicle occupancies", {
					cause,
				});
				console.error(error);
				return undefined;
			});
	}

	if (typeof cached === "undefined") return getFromCache(vehicleNumber);

	const vehicleLine = cached?.find((line) =>
		line.includes(`( ${vehicleNumber} )`),
	);
	if (typeof vehicleLine === "undefined") return getFromCache(vehicleNumber);

	const id = vehicleLine.slice(
		vehicleLine.indexOf("('") + 2,
		vehicleLine.indexOf("')"),
	);

	const loadLine = cached?.find((line) => line.includes(`${id}_load`));
	if (typeof loadLine === "undefined") return getFromCache(vehicleNumber);

	const [, backgroundColor] =
		/background-color:#([a-z0-9]{6});/.exec(loadLine) ?? [];
	if (typeof backgroundColor === "undefined")
		return getFromCache(vehicleNumber);

	const status = backgroundColor ? levels[backgroundColor] : undefined;
	if (!status) return getFromCache(vehicleNumber);

	vehicleCache.set(vehicleNumber, {
		status,
		recordedAt: Date.now(),
	});

	return status;
}
