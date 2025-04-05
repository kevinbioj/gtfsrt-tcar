import { HubConnectionBuilder } from "@microsoft/signalr";

export type Vehicle = {
	OperatorRef: string;
	OperatorId: number;
	VehicleRef: string;
	VJourneyId: number;
	VJourneyMode: string;
	LineName: string;
	LineNumber: string;
	LineId: number;
	Direction: number;
	Latitude: number;
	Longitude: number;
	VehicleAtStop: boolean;
	Bearing: number;
	Destination: string;
	RecordedAtTime: string;
	RecordedDisplayTime: string;
	PushedDisplayTime: string;
	IsDisrupted: boolean;
	StopTimeList: StopTime[];
};

export type StopTime = {
	IsMonitored: boolean;
	IsCancelled: boolean;
	IsDisrupted: boolean;
	StopPointId: number;
	StopPointName: string;
	StopPointOrder: number;
	AimedTime: string;
	AimedDisplayTime: string;
	ExpectedTime: string;
	ExpectedDisplayTime: string;
	WaitingTime: number;
};

export async function createVehicleProvider(
	href: string,
	lines: string[],
	onVehicle: (line: string, vehicle: Vehicle) => void,
) {
	const connection = new HubConnectionBuilder().withUrl(href).build();

	try {
		await connection.start();
		for (const line of lines) {
			await connection.invoke("Join", `#lineId:${line}:1`);
			await connection.invoke("Join", `#lineId:${line}:2`);
		}
	} catch (cause) {
		throw new Error("Unable to connect to the vehicle provider.", { cause });
	}

	connection.on("dataReceived", (line, payload) => {
		try {
			onVehicle(line, JSON.parse(payload));
		} catch (cause) {
			const error = new Error("An error occurred in the vehicle handling function", { cause });
			console.error(error);
		}
	});

	return connection;
}
