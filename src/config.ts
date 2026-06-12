export const ALLOWED_LINES = new Set(['90', '91', '92', '93', '94', '95', '01', '02', '03', '04', '05', '07', '08', '10', '11', '15', '20', '22', '41', '43', '98']);

export const PORT = 3000;
export const POLL_INTERVAL = 20_000;
export const VEHICLE_POSITIONS_URL =
	"https://api.mrn.cityway.fr/dataflow/vehicle-tc-tr/download?provider=TCAR&dataFormat=GTFS-RT";
export const TRIP_UPDATES_URL =
	"https://api.mrn.cityway.fr/dataflow/horaire-tc-tr/download?provider=TCAR&dataFormat=GTFS-RT";
export const VERIFICATION_FEED_URL = "https://reseau-astuce.fr/ftp/gtfsrt/Astuce.VehiclePosition.pb";
export const VEHICLE_OCCUPANCY_STALENESS = Temporal.Duration.from({ minutes: 3 }).total("milliseconds");
export const VEHICLE_OCCUPANCY_STATUS_URL = atob("aHR0cHM6Ly90Y2FyLmZsb3dseS5yZS9Qb3J0YWwvTWFwRGV2aWNlcy5hc3B4");
