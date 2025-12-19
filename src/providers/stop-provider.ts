export const ctwStopIdToGtfsStopId = new Map<number, string>();
export const ctwIdApToGtfsStopId = new Map<string, string>();

type StopListResponse = {
	Data: {
		Id: number;
		IdAp: string;
		Code: string;
	}[];
};

const updateStopMap = async () => {
	console.log("|> Updating stop list.");
	const response = await fetch(
		"https://api.mrn.cityway.fr:443/api/transport/v3/stop/GetStops/json?OperatorIds=1",
	);
	if (!response.ok) {
		return;
	}

	const payload = (await response.json()) as StopListResponse;

	for (const stop of payload.Data) {
		ctwStopIdToGtfsStopId.set(stop.Id, stop.Code);
		ctwIdApToGtfsStopId.set(stop.IdAp, stop.Code);
	}
};

await updateStopMap();
setInterval(updateStopMap, 360_000);
