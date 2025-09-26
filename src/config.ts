//- Feed URLs
export const GTFS_FEED =
	"https://api.mrn.cityway.fr/dataflow/offre-tc/download?provider=TCAR&dataFormat=GTFS";
export const HUB_FEED =
	"https://api.mrn.cityway.fr/dataflow/offre-tc/download?provider=TCAR&dataFormat=HUB";
export const VEHICLE_WS = "https://api.mrn.cityway.fr/sdh/vehicles";
export const OLD_GTFSRT_VP_FEED =
	"https://reseau-astuce.fr/ftp/gtfsrt/Astuce.VehiclePosition.pb";
export const OLD_GTFSRT_TU_FEED =
	"https://reseau-astuce.fr/ftp/gtfsrt/Astuce.TripUpdate.pb";

//- Monitored lines - api.mrn.cityway.fr
export const MONITORED_LINES = [
	"24211", // 90 - Métro
	"24212", // 91 - T1
	"24213", // 92 - T2
	"24214", // 93 - T3
	"24215", // 94 - T4
	"24099", // 01 - F1
	"24100", // 02 - F2
	"24101", // 03 - F3
	"24102", // 04 - F4
	"24103", // 05 - F5
	"24104", // 06 - F6
	"24105", // 07 - F7
	"24106", // 08 - F8
	"24108", // 10 - 10
	"24115", // 11 - 11
	"24116", // 13 - 13
	"24117", // 14 - 14
	"24118", // 15 - 15
	"24119", // 20 - 20
	"24133", // 22 - 22
	"24144", // 27 - 27
	"24145", // 28 - 28
	"24157", // 33 - 33
	"24169", // 35 - 35
	"24172", // 36 - 36
	"24177", // 37 - 37
	"24178", // 38 - 38
	"24186", // 41 - 41
	"24192", // 42 - 42
	"24193", // 43 - 43
	"24194", // 44 - 44
	"24208", // 529 - 529
	"40874", // 98 - Noctambus
	"24217", // 99 - Calypso
	"40822", // 300 - 300
	"40823", // 301 - 301
	"40824", // 302 - 302
	"40825", // 303 - 303
	"40826", // 305 - 305
	"40827", // 310 - 310
	"40828", // 311 - 311
	"40829", // 313 - 313
	"40830", // 314 - 314
	"40831", // 315 - 315
	"40878", // 322 - 322
	"40832", // 330 - 330
	"40833", // 331 - 331
	"40834", // 332 - 332
	"40835", // 333 - 333
	"40836", // 334 - 334
	"40837", // 335 - 335
	"40838", // 336 - 336
	"40839", // 340 - 340
	"40840", // 341 - 341
	"40841", // 342 - 342
	"40842", // 343 - 343
	"40843", // 350 - 350
	"40844", // 351 - 351
	"40845", // 360 - 360
	"40846", // 361 - 361
	"40847", // 363 - 363
	"40848", // 364 - 364
	"40800", // 201 - 201
	"40801", // 202 - 202
	"40802", // 203 - 203
	"40803", // 204 - 204
	"40804", // 205 - 205
	"40805", // 206 - 206
	"40806", // 207 - 207
	"40807", // 208 - 208
	"40808", // 210 - 210
	"40809", // 211 - 211
	"40810", // 212 - 212
	"40811", // 213 - 213
	"40812", // 214 - 214
	"40813", // 220 - 220
	"40814", // 221 - 221
	"40815", // 222 - 222
	"40816", // 224 - 224
	"40817", // 225 - 225
	"40818", // 227 - 227
	"40819", // 228 - 228
	"40820", // 229 - 229
];

//- Monitored lines - preprod.api.mrn.cityway.fr
// export const MONITORED_LINES = [
//   "117", // M
//   "24210", // N
//   "118", // T1
//   "119", // T2
//   "120", // T3
//   "121", // T4
//   "2989", // F1
//   "2990", // F2
//   "2991", // F3
//   "1", // F4
//   "2", // F5
//   "3", // F6
//   "4", // F7
//   "5", // F8
//   "24107", // F9
//   "7", // 10
//   "15", // 11
//   "16", // 13
//   "2998", // 14
//   "2999", // 15
//   "18", // 20
//   "34", // 22
//   "45", // 27
//   "3001", // 28
//   "61", // 33
//   "74", // 35
//   "93", // 41
//   "99", // 42
//   "100", // 43
//   "122", // NOCT
// ];

//- Control dataset
export const LINES_DATASET = new Map([
	[
		"Métro",
		{
			code: "90",
			destinations: [
				"Boulingrin B",
				"Boulingrin C",
				"Théâtre des Arts",
				"Georges Braque",
				"Technopôle",
			],
		},
	],
	["T1", { code: "91", destinations: ["Mont aux Malades", "CHU Ch. Nicolle"] }],
	["T2", { code: "92", destinations: ["Tamarelle", "V. Schoelcher"] }],
	["T3", { code: "93", destinations: ["Monet", "Durécu-Lavoisier"] }],
	["T4", { code: "94", destinations: ["Marie Curie-MTC", "Zénith-Parc Expo"] }],
	["F1", { code: "01", destinations: ["Pl. de la Ronce", "Stade Diochon"] }],
	["F2", { code: "02", destinations: ["Tamarelle", "La Vatine-C.Cial"] }],
	[
		"F3",
		{
			code: "03",
			destinations: ["HDV Sotteville", "Pôle Multimodal", "C. Commercial"],
		},
	],
	["F4", { code: "04", destinations: ["Mont-Riboudet", "Hameau Frévaux"] }],
	[
		"F5",
		{
			code: "05",
			destinations: ["Lycée Galilée", "Théâtre des Arts", "Boulingrin"],
		},
	],
	[
		"F6",
		{
			code: "06",
			destinations: ["Les Bouttières", "Gare St-Etienne", "Georges Braque"],
		},
	],
	["F7", { code: "07", destinations: ["La Pléiade", "HDV Sotteville"] }],
	["F8", { code: "08", destinations: ["Tamarelle", "Lycée du Cailly"] }],
	["10", { code: "10", destinations: ["Maromme La Maine", "Lycée Flaubert"] }],
	["11", { code: "11", destinations: ["Ile Lacroix", "Coll. L.de Vinci"] }],
	["13", { code: "13", destinations: ["Ecole de Musique", "Martainville"] }],
	["14", { code: "14", destinations: ["Mont Pilon", "Mairie Belbeuf"] }],
	[
		"15",
		{
			code: "15",
			destinations: [
				"Collège J. Verne",
				"Jules Verne",
				"Hôtel de Ville",
				"Eude",
				"Grand Val",
			],
		},
	],
	[
		"20",
		{
			code: "20",
			destinations: [
				"Le Chapître",
				"Hôtel de Ville",
				"Rue de l'Eglise",
				"Mairie St Aubin",
			],
		},
	],
	["22", { code: "22", destinations: ["P. de la Vatine", "Barr.de Darnétal"] }],
	[
		"27",
		{
			code: "27",
			destinations: ["Bel Air", "Théâtre des Arts", "Champlain", "Boulingrin"],
		},
	],
	["28", { code: "28", destinations: ["Louise Michel", "Bois Tison"] }],
	["33", { code: "33", destinations: ["HDV Sotteville", "F. Truffaut"] }],
	["35", { code: "35", destinations: ["Ecole Moulin", "Sente Houdeville"] }],
	[
		"41",
		{
			code: "41",
			destinations: ["Ancienne Mare", "La Bastille", "Vente Olivier"],
		},
	],
	[
		"42",
		{ code: "42", destinations: ["Lebon", "Centre Routier", "La Houssière"] },
	],
	["43", { code: "43", destinations: ["Place du Vivier", "Longs Vallons"] }],
	["44", { code: "44", destinations: ["E. Lacroix", "Chapelle St-Siméon"] }],
]);
