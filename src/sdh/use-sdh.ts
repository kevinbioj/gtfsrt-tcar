import { HubConnectionBuilder, HubConnectionState } from "@microsoft/signalr";

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

export async function useSdh(sdhUrl: string, lines: string[], onVehicle: (line: string, vehicle: Vehicle) => void) {
	const connection = new HubConnectionBuilder()
		.withAutomaticReconnect({ nextRetryDelayInMilliseconds: () => 10_000 })
		.withKeepAliveInterval(10_000)
		.withServerTimeout(30_000)
		.withUrl(sdhUrl)
		.build();

	const registerLines = async () => {
		try {
			for (const line of lines) {
				await connection.invoke("Join", `#lineId:${line}:1`);
				await connection.invoke("Join", `#lineId:${line}:2`);
			}
			console.log("✔ Successfully registered to all lines.");
		} catch (error) {
			console.error("✘ Failed to register lines:", error);
		}
	};

	connection.onreconnected(registerLines);

	connection.onclose((error) => {
		console.error("✘ Sdh connection closed:", error);
		startConnection();
	});

	async function startConnection() {
		while (true) {
			if (connection.state === HubConnectionState.Connected) {
				break;
			}

			if (connection.state === HubConnectionState.Disconnected) {
				try {
					await connection.start();
					console.log("✔ Sdh connected.");
					await registerLines();
					break;
				} catch (error) {
					console.error("✘ Failed to connect to Sdh, retrying in 10s...", error);
				}
			}

			await new Promise((resolve) => setTimeout(resolve, 10_000));
		}
	}

	startConnection();

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
