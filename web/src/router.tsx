import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { AlertsPage } from "@/pages/alerts/alerts-page";
import { ModificationEditorPage } from "@/pages/editor/editor-page";
import { ModificationsPage } from "@/pages/modifications/modifications-page";
import { StopEditorPage } from "@/pages/stops/stop-editor-page";
import { StopsPage } from "@/pages/stops/stops-page";

const rootRoute = createRootRoute({ component: AppShell });

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	beforeLoad: () => {
		throw redirect({ to: "/alerts" });
	},
});

export const alertsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/alerts",
	validateSearch: (search: Record<string, unknown>): { alert?: string; todo?: boolean } => ({
		...(typeof search.alert === "string" || typeof search.alert === "number" ? { alert: String(search.alert) } : {}),
		...(search.todo === true || search.todo === "true" ? { todo: true } : {}),
	}),
	component: AlertsPage,
});

export const modificationsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/modifications",
	component: ModificationsPage,
});

/** L'info trafic d'où l'on vient, s'il y en a une : l'éditeur y ramène à l'enregistrement. */
const fromAlert = (search: Record<string, unknown>): { alert?: string } =>
	typeof search.alert === "string" || typeof search.alert === "number" ? { alert: String(search.alert) } : {};

export const newModificationRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/modifications/new",
	validateSearch: fromAlert,
	component: function NewModificationRoute() {
		const { alert } = newModificationRoute.useSearch();
		return <ModificationEditorPage uid={null} alert={alert ?? null} />;
	},
});

export const modificationRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/modifications/$uid",
	validateSearch: fromAlert,
	component: function ModificationRoute() {
		const { uid } = modificationRoute.useParams();
		const { alert } = modificationRoute.useSearch();
		return <ModificationEditorPage key={uid} uid={Number(uid)} alert={alert ?? null} />;
	},
});

export const stopsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/stops",
	component: StopsPage,
});

export const newStopRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/stops/new",
	component: () => <StopEditorPage stopId={null} />,
});

export const stopRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/stops/$stopId",
	component: function StopRoute() {
		const { stopId } = stopRoute.useParams();
		return <StopEditorPage stopId={stopId} />;
	},
});

const routeTree = rootRoute.addChildren([
	indexRoute,
	alertsRoute,
	modificationsRoute,
	newModificationRoute,
	modificationRoute,
	stopsRoute,
	newStopRoute,
	stopRoute,
]);

/** La racine de l'interface telle que le navigateur la voit — « /gtfs-rt/tcar/admin » derrière le proxy. */
const basepath = new URL(document.baseURI).pathname.replace(/\/$/, "");

export const router = createRouter({ routeTree, basepath, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
