//- Feed URLs
export const GTFS_FEED = "https://api.mrn.cityway.fr/dataflow/offre-tc/download?provider=TCAR&dataFormat=GTFS";
export const HUB_FEED = "https://api.mrn.cityway.fr/dataflow/offre-tc/download?provider=TCAR&dataFormat=HUB";
export const VEHICLE_WS = "https://api.mrn.cityway.fr/sdh/vehicles";
export const OLD_GTFSRT_VP_FEED = "https://tsi.tcar.cityway.fr/ftp/gtfsrt/Astuce.VehiclePosition.pb";

//- Monitored lines
export const MONITORED_LINES = [
  "24211", // M
  "24210", // N
  "24212", // T1
  "24213", // T2
  "24214", // T3
  "24215", // T4
  "24099", // F1
  "24100", // F2
  "24101", // F3
  "24102", // F4
  "24103", // F5
  "24104", // F6
  "24105", // F7
  "24106", // F8
  "24107", // F9
  "24108", // 10
  "24115", // 11
  "24116", // 13
  "24117", // 14
  "24118", // 15
  "24119", // 20
  "24133", // 22
  "24144", // 27
  "24145", // 28
  "24157", // 33
  "24169", // 35
  "24186", // 41
  "24192", // 42
  "24193", // 43
  "40874", // NOCT
];

//- Control dataset
export const LINES_DATASET = new Map([
  [
    "Métro",
    { code: "90", destinations: ["Boulingrin B", "Boulingrin C", "Théâtre des Arts", "Georges Braque", "Technopôle"] },
  ],
  ["T1", { code: "91", destinations: ["Mont aux Malades", "CHU Ch. Nicolle"] }],
  ["T2", { code: "92", destinations: ["Tamarelle", "V. Schoelcher"] }],
  ["T3", { code: "93", destinations: ["Monet", "Durécu-Lavoisier"] }],
  ["T4", { code: "94", destinations: ["Marie Curie-MTC", "Zénith-Parc Expo"] }],
  ["F1", { code: "01", destinations: ["Pl. de la Ronce", "Stade Diochon"] }],
  ["F2", { code: "02", destinations: ["Tamarelle", "La Vatine-C.Cial"] }],
  ["F3", { code: "03", destinations: ["HDV Sotteville", "Pôle Multimodal", "C. Commercial"] }],
  ["F4", { code: "04", destinations: ["Mont-Riboudet", "Hameau Frévaux"] }],
  ["F5", { code: "05", destinations: ["Lycée Galilée", "Théâtre des Arts"] }],
  ["F6", { code: "06", destinations: ["Les Bouttières", "Gare St-Etienne"] }],
  ["F7", { code: "07", destinations: ["La Pléiade", "HDV Sotteville"] }],
  ["F8", { code: "08", destinations: ["Tamarelle", "Lycée du Cailly"] }],
  ["10", { code: "10", destinations: ["Maromme La Maine", "Lycée Flaubert"] }],
  ["11", { code: "11", destinations: ["Ile Lacroix", "Coll. L.de Vinci"] }],
  ["13", { code: "13", destinations: ["Ecole de Musique", "Martainville"] }],
  ["14", { code: "14", destinations: ["Mont Pilon", "Mairie Belbeuf"] }],
  ["15", { code: "15", destinations: ["Collège J. Verne", "Jules Verne", "Eude", "Grand Val"] }],
  ["20", { code: "20", destinations: ["Le Chapître", "Rue de l'Eglise", "Mairie St Aubin"] }],
  ["22", { code: "22", destinations: ["P. de la Vatine", "Barr.de Darnétal"] }],
  ["27", { code: "27", destinations: ["Bel Air", "Théâtre des Arts"] }],
  ["28", { code: "28", destinations: ["Louise Michel", "Bois Tison"] }],
  ["33", { code: "33", destinations: ["HDV Sotteville", "F. Truffaut"] }],
  ["35", { code: "35", destinations: ["Ecole Moulin", "Sente Houdeville"] }],
  ["41", { code: "41", destinations: ["Ancienne Mare", "La Bastille", "Vente Olivier"] }],
  ["42", { code: "42", destinations: ["Lebon", "Centre Routier", "La Houssière"] }],
  ["43", { code: "43", destinations: ["Place du Vivier", "Longs Vallons"] }],
  ["44", { code: "44", destinations: ["E. Lacroix", "Chapelle St-Siméon"] }],
]);
