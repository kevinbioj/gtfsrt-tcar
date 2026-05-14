import { Temporal } from "temporal-polyfill";

export const HUB_RESOURCE_URL = "https://api.mrn.cityway.fr/dataflow/offre-tc/download?provider=TCAR&dataFormat=HUB";
export const PORT = 3000;
export const SDH_URL = "https://api.mrn.cityway.fr/sdh/vehicles";
export const SWEEP_THRESHOLD = Temporal.Duration.from({ minutes: 15 }).total("milliseconds");
export const VEHICLE_OCCUPANCY_STALENESS = Temporal.Duration.from({ minutes: 3 }).total("milliseconds");
export const VEHICLE_OCCUPANCY_STATUS_URL = atob("aHR0cHM6Ly90Y2FyLmZsb3dseS5yZS9Qb3J0YWwvTWFwRGV2aWNlcy5hc3B4");
export const VERIFICATION_FEED_URL = "https://reseau-astuce.fr/ftp/gtfsrt/Astuce.VehiclePosition.pb";
export const VERIFICATION_TRIP_UPDATES_URL = "https://reseau-astuce.fr/ftp/gtfsrt/Astuce.TripUpdate.pb";

export const MONITORED_LINES = [
	"24211", // Métro
	"24212", // T1
	"24213", // T2
	"24214", // T3
	"24215", // T4
	"61669", // T5
	"24099", // F1
	"24100", // F2
	"24101", // F3
	"24102", // F4
	"24103", // F5
	"24105", // F7
	"24106", // F8
	"24108", // 10
	"24115", // 11
	"24118", // 15
	"24119", // 20
	"24133", // 22
	"24186", // 41
	"24193", // 43
	"40874", // Noctambus
];

export const VERIFIED_ROUTE_DESTINATIONS: Record<string, [string[], string[]]> = {
	"TCAR:90": [
		["Georges Braque", "Technopôle"],
		["Boulingrin B", "Boulingrin C"],
	],
	"TCAR:91": [["CHU Ch. Nicolle"], ["Mont aux Malades"]],
	"TCAR:92": [["Tamarelle"], ["V. Schoelcher"]],
	"TCAR:93": [["Durécu-Lavoisier"], ["Monet"]],
	"TCAR:94": [["ESIGELEC", "Technopôle"], ["Marie Curie-MTC"]],
	"TCAR:95": [["Champlain"], ["Mont aux Malades"]],
	"TCAR:01": [["Stade Diochon"], ["Pl. de la Ronce"]],
	"TCAR:02": [["Tamarelle"], ["La Vatine-C.Cial"]],
	"TCAR:03": [["C. Commercial", "Pôle Multimodal"], ["HDV Sotteville"]],
	"TCAR:04": [["Mont-Riboudet"], ["Hameau Frévaux"]],
	"TCAR:05": [["Lycée Galilée"], ["Théâtre des Arts"]],
	"TCAR:07": [["HDV Sotteville"], ["La Pléiade"]],
	"TCAR:08": [["Tamarelle"], ["Lycée du Cailly"]],
	"TCAR:10": [["Lycée Flaubert"], ["Maromme La Maine"]],
	"TCAR:11": [["Ile Lacroix"], ["Coll. L.de Vinci"]],
	"TCAR:15": [
		["Grand Val", "Hôtel de Ville"],
		["Collège J. Verne", "Eude", "Hôtel de Ville"],
	],
	"TCAR:20": [
		["Hôtel de Ville", "Mairie St Aubin", "Rue de l'Eglise"],
		["Le Chapître", "Hôtel de Ville"],
	],
	"TCAR:22": [["Barr.de Darnétal"], ["P. de la Vatine"]],
	"TCAR:41": [["La Bastille"], ["Ancienne Mare"]],
	"TCAR:43": [["Place du Vivier"], ["Longs Vallons"]],
	"TCAR:98": [["Cateliers", "Hôtel de Ville"], ["La Pléiade"]],
};
