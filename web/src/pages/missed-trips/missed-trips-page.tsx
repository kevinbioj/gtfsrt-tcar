import type { LineDto, MissedDirectionDto, MissedReason, MissedTripDto, MissedTripsDto, RouteDto } from "@dto";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { BusFrontIcon, DownloadIcon, Undo2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { LineBadge, LineOption, serviceOf } from "@/components/line-badge";
import { FilterBar, PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { StatusPill } from "@/components/status-pill";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatClock, formatGtfsTime, plural } from "@/lib/format";
import { useMissedTrips, useRoutes, useSetMissedTripRestored } from "@/lib/queries";

export type MissedTripTab = "cancelled" | "restored" | "all";

export const TABS: { value: MissedTripTab; label: string; keeps: (trip: MissedTripDto) => boolean }[] = [
	{ value: "cancelled", label: "Supprimées", keeps: (trip) => trip.restoredAt === null },
	{ value: "restored", label: "Rétablies", keeps: (trip) => trip.restoredAt !== null },
	{ value: "all", label: "Toutes", keeps: () => true },
];

const REASONS: Record<MissedReason, string> = {
	absent: "Aucun trip update",
	ghost: "Trip update retard=0 + pas de véhicule rattaché",
};

/**
 * Des largeurs fixes, d'une carte à l'autre : les colonnes s'alignent. La course et l'arrêt de
 * référence prennent celle de leur contenu le plus long (cf. `useColumnWidths`), le motif ce qui reste.
 */
const COLUMNS = [
	{ label: "ID course", width: "w-24" },
	{ label: "Course", width: "w-(--course-width)" },
	{ label: "Arrêt de référence", width: "w-(--reference-width)" },
	{ label: "Motif", width: "" },
	{ label: "Constatée", width: "w-24" },
	{ label: "État", width: "w-32" },
	{ label: "", width: "w-40" },
];

const EMPTY_TEXTS: Record<MissedTripTab, string> = {
	cancelled: "Aucune course n'est publiée supprimée pour l'instant.",
	restored: "Aucune course n'a été rétablie aujourd'hui.",
	all: "Aucune course n'a été constatée non honorée aujourd'hui.",
};

/** Ce qu'on ajoute quand les courses terminées sont masquées : il y en a peut-être. */
const FINISHED_HINT = "Les courses terminées sont masquées.";

/**
 * Les courses du jour qui ne circulent pas faute de matériel, ligne par ligne : celles que le
 * producteur publie supprimées, et celles qu'on a rétablies. Le constat se fait seul, au fil des
 * relevés ; on ne fait ici que le contredire — pour la journée seulement.
 */
export function MissedTripsPage() {
	const { data, isPending } = useMissedTrips();
	const routes = useRoutes();
	const search = useSearch({ from: "/missed-trips" });
	const { tab = "cancelled", line = "all", finished = false } = search;
	const navigate = useNavigate({ from: "/missed-trips" });
	const filter = (change: Partial<typeof search>) => navigate({ search: (current) => ({ ...current, ...change }) });

	const groups = data?.lines ?? EMPTY;
	// Les lignes qui ont au moins une course non honorée, dans l'ordre du réseau.
	const lines = useMemo(() => {
		const used = new Set(groups.map((group) => group.line.routeId));
		return (routes.data ?? []).filter((route) => used.has(route.routeId));
	}, [groups, routes.data]);
	// La ligne choisie, et les courses terminées seulement si on les demande : les compteurs des onglets
	// se comptent là-dessus, comme ce qui s'affiche.
	const onLine = groups
		.filter((group) => line === "all" || group.line.routeId === line)
		.map((group) => ({
			...group,
			directions: group.directions.map((direction) => ({
				...direction,
				trips: direction.trips.filter((trip) => finished || !trip.finished),
			})),
		}));
	const widths = useColumnWidths(groups);
	const count = (value: MissedTripTab) =>
		onLine.flatMap(tripsOf).filter(TABS.find((entry) => entry.value === value)?.keeps ?? (() => false)).length;
	const keeps = TABS.find((entry) => entry.value === tab)?.keeps ?? (() => true);
	const visible = onLine
		.map((group) => ({
			...group,
			directions: group.directions
				.map((direction) => ({ ...direction, trips: direction.trips.filter(keeps) }))
				.filter((direction) => direction.trips.length > 0),
		}))
		.filter((group) => group.directions.length > 0);

	return (
		<>
			<PageHeader
				title="Courses supp."
				description="Courses du jour parties depuis plus de 5 min sans véhicule ni avance-retard, ou absentes du SAE : elles sont publiées supprimées. Un rétablissement ne vaut que pour aujourd'hui."
			>
				<Button variant="outline" size="lg" disabled={groups.length === 0} onClick={() => downloadCsv(groups)}>
					<DownloadIcon data-icon="inline-start" />
					Exporter en CSV
				</Button>
			</PageHeader>

			<FilterBar>
				<Tabs
					value={tab}
					onValueChange={(value) => filter({ tab: value === "cancelled" ? undefined : (value as MissedTripTab) })}
				>
					<TabsList aria-label="Filtrer par état">
						{TABS.map((entry) => (
							<TabsTrigger key={entry.value} value={entry.value} className="gap-2">
								{entry.label}
								<span className="font-mono text-xs text-subtle">{count(entry.value)}</span>
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
				<label className="flex items-center gap-2 text-[13px] font-medium text-strong">
					<Checkbox checked={finished} onCheckedChange={(on) => filter({ finished: on === true ? true : undefined })} />
					Afficher les courses terminées
				</label>
				<label className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-strong">
					Ligne
					<Select value={line} onValueChange={(next) => filter({ line: next === "all" ? undefined : next })}>
						<SelectTrigger className="w-64 max-w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								<SelectItem value="all">Toutes les lignes</SelectItem>
								{lines.map((entry) => (
									<SelectItem key={entry.routeId} value={entry.routeId}>
										<LineOption route={entry} />
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</label>
			</FilterBar>

			<div className="flex flex-col gap-3.5 px-6 pt-5 pb-10" style={widths}>
				{isPending ? (
					[0, 1].map((index) => <Skeleton key={index} className="h-40 rounded-lg" />)
				) : visible.length === 0 ? (
					<Empty className="rounded-lg border bg-card">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<BusFrontIcon />
							</EmptyMedia>
							<EmptyTitle>Aucune course non honorée</EmptyTitle>
							<EmptyDescription>
								{EMPTY_TEXTS[tab]}
								{finished ? null : ` ${FINISHED_HINT}`}
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					visible.map((group) => (
						<SectionCard
							key={group.line.routeId}
							title={
								<LineTitle
									line={group.line}
									route={routes.data?.find((route) => route.routeId === group.line.routeId)}
								/>
							}
							hint={plural(tripsOf(group).length, "course")}
						>
							<div className="overflow-x-auto">
								<Table
									className="table-fixed"
									// De quoi laisser au motif une largeur lisible ; en deçà, le tableau défile.
									style={{ minWidth: "calc(var(--course-width) + var(--reference-width) + var(--spacing) * 170)" }}
								>
									<TableHeader>
										<TableRow>
											{COLUMNS.map(({ label, width }) => (
												<TableHead
													key={label}
													className={cn("text-xs font-semibold tracking-wider text-subtle uppercase", width)}
												>
													{label}
												</TableHead>
											))}
										</TableRow>
									</TableHeader>
									<TableBody>
										{group.directions.map((direction) => (
											<DirectionRows key={direction.directionId} direction={direction} />
										))}
									</TableBody>
								</Table>
							</div>
						</SectionCard>
					))
				)}
			</div>
		</>
	);
}

/** Les courses d'un sens, sous l'intitulé de ses destinations. */
function DirectionRows({ direction }: { direction: MissedDirectionDto }) {
	return (
		<>
			<TableRow className="hover:bg-transparent">
				<TableCell colSpan={COLUMNS.length} className="bg-muted py-1.5 text-xs font-semibold text-subtle">
					Direction {direction.headsigns.join(" / ")}
				</TableCell>
			</TableRow>
			{direction.trips.map((trip) => (
				<MissedTripRow key={trip.run} trip={trip} />
			))}
		</>
	);
}

function MissedTripRow({ trip }: { trip: MissedTripDto }) {
	const setRestored = useSetMissedTripRestored();

	return (
		// Une course terminée — arrivée théorique passée — se grise : elle n'intéresse plus que l'historique.
		// Le survol la rend lisible, le temps d'y regarder de près.
		<TableRow className={cn(trip.finished && "opacity-55 grayscale transition hover:opacity-100 hover:grayscale-0")}>
			{/* Le `trip_id` du GTFS, sans le préfixe du réseau : « TCAR:1716 » se lit « 1716 ». */}
			<TableCell className="font-mono" title={trip.tripId}>
				{trip.tripId.split(":").at(-1)}
			</TableCell>
			<TableCell>
				<TripSchedule trip={trip} />
			</TableCell>
			<TableCell>
				<span className="flex gap-x-[8px]">
					<span className="font-mono">{formatGtfsTime(trip.reference.time)}</span>
					<span className="truncate" title={trip.reference.name}>
						{trip.reference.name}
					</span>
				</span>
			</TableCell>
			<TableCell className="whitespace-normal text-muted-foreground">{REASONS[trip.reason]}</TableCell>
			<TableCell className="font-mono">{formatClock(trip.detectedAt).slice(0, 5)}</TableCell>
			<TableCell>
				{trip.restoredAt === null ? (
					<StatusPill tone="danger">Supprimée</StatusPill>
				) : (
					<StatusPill tone="caution">Rétablie à {formatClock(trip.restoredAt).slice(0, 5)}</StatusPill>
				)}
			</TableCell>
			<TableCell className="text-right">
				{/* Une course terminée n'a plus rien à annoncer : on ne la rétablit ni ne la supprime plus. */}
				{trip.finished ? (
					<span className="pr-2.5 text-[13px] text-muted-foreground">Terminée</span>
				) : trip.restoredAt === null ? (
					<AlertDialog>
						<AlertDialogTrigger asChild>
							<Button variant="outline" size="sm" disabled={setRestored.isPending}>
								<Undo2Icon data-icon="inline-start" />
								Rétablir
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Rétablir cette course ?</AlertDialogTitle>
								<AlertDialogDescription>
									<TripLabel trip={trip} />. Elle ne sera plus publiée supprimée et repartira de ce que publie le
									GTFS-RT source, jusqu'à la fin de la journée.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Annuler</AlertDialogCancel>
								<AlertDialogAction onClick={() => setRestored.mutate({ run: trip.run, restored: true })}>
									Rétablir
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				) : (
					<Button
						variant="ghost"
						size="sm"
						disabled={setRestored.isPending}
						onClick={() => setRestored.mutate({ run: trip.run, restored: false })}
					>
						Supprimer à nouveau
					</Button>
				)}
			</TableCell>
		</TableRow>
	);
}

/** Une ligne en titre de carte : son pictogramme, puis « T1 - Mont aux Malades ↔ CHU Charles Nicolle ». */
function LineTitle({ line, route }: { line: LineDto; route: RouteDto | undefined }) {
	return (
		<span className="flex min-w-0 items-center gap-2.5">
			<LineBadge line={line} size="lg" />
			<span className="truncate">{route === undefined ? line.line : `${line.line} - ${serviceOf(route)}`}</span>
		</span>
	);
}

/** Une course, « Terminus HH:mm → HH:mm Terminus », aux heures du GTFS (« 25:10 »). */
function TripLabel({ trip }: { trip: MissedTripDto }) {
	return (
		<span>
			{trip.origin} <span className="font-mono">{formatGtfsTime(trip.departure)}</span>
			{" → "}
			<span className="font-mono">{formatGtfsTime(trip.arrival)}</span> {trip.destination}
		</span>
	);
}

/**
 * La même, en tableau : le terminus de départ calé à droite sur la largeur commune (`--origin-width`),
 * les heures en chasse fixe — les flèches tombent toutes l'une sous l'autre.
 */
function TripSchedule({ trip }: { trip: MissedTripDto }) {
	return (
		<span className="grid grid-cols-[var(--origin-width)_auto_auto_auto_minmax(0,1fr)] items-baseline gap-x-[8px]">
			<span className="truncate text-right" title={trip.origin}>
				{trip.origin}
			</span>
			<span className="font-mono">{formatGtfsTime(trip.departure)}</span>
			<span>→</span>
			<span className="font-mono">{formatGtfsTime(trip.arrival)}</span>
			<span className="truncate" title={trip.destination}>
				{trip.destination}
			</span>
		</span>
	);
}

const EMPTY: MissedTripsDto["lines"] = [];

/** Les courses d'une ligne, tous sens confondus. */
const tripsOf = (group: MissedTripsDto["lines"][number]) => group.directions.flatMap((direction) => direction.trips);

/** Les polices des cellules du tableau (`text-sm`), telles que le canevas les mesure. */
const TABLE_FONT = '14px "IBM Plex Sans", system-ui, sans-serif';
const TABLE_MONO_FONT = '14px "IBM Plex Mono", ui-monospace, monospace';

/** Ce qu'on laisse en plus du nom le plus long, en pixels. */
const TEXT_MARGIN = 12;
/** L'écart entre les morceaux d'une cellule (`gap-x-[8px]`), en pixels. */
const GAP = 8;
/** Assez pour l'intitulé « Arrêt de référence », en pixels. */
const REFERENCE_MIN_WIDTH = 170;

/**
 * Les largeurs communes à toutes les cartes, en variables CSS : celle des terminus de départ
 * (`--origin-width`), sur laquelle les flèches s'alignent, et celles des colonnes « Course » et
 * « Arrêt de référence », taillées pour que rien n'y soit tronqué. Elles se calculent sur toutes les
 * courses de la journée, et non sur celles qu'on affiche : rien ne bouge d'un filtre à l'autre.
 *
 * Les noms se mesurent dans la police du tableau une fois qu'elle est chargée ; d'ici là — ou sans
 * canevas —, ils s'estiment large, une police en retard ne devant rien tronquer.
 */
function useColumnWidths(groups: MissedTripsDto["lines"]): React.CSSProperties {
	const [fontsLoaded, setFontsLoaded] = useState(false);
	useEffect(() => {
		let live = true;
		Promise.all([document.fonts.load(TABLE_FONT), document.fonts.load(TABLE_MONO_FONT)])
			.then(() => {
				if (live) setFontsLoaded(true);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

	return useMemo(() => {
		const trips = groups.flatMap(tripsOf);
		const context = fontsLoaded ? document.createElement("canvas").getContext("2d") : null;
		const widest = (texts: string[], font: string) => {
			if (context === null) return Math.max(0, ...texts.map((text) => text.length * 9));
			context.font = font;
			return Math.ceil(Math.max(0, ...texts.map((text) => context.measureText(text).width)));
		};

		const time = widest(["00:00"], TABLE_MONO_FONT);
		const arrow = widest(["→"], TABLE_FONT);
		const origin = widest(
			trips.map((trip) => trip.origin),
			TABLE_FONT,
		);
		const destination = widest(
			trips.map((trip) => trip.destination),
			TABLE_FONT,
		);
		const reference = Math.max(
			REFERENCE_MIN_WIDTH,
			time +
				GAP +
				widest(
					trips.map((trip) => trip.reference.name),
					TABLE_FONT,
				),
		);
		// Les cellules ont leur marge intérieure (`p-2`), à l'échelle de l'interface.
		const padded = (width: number) => `calc(${width + TEXT_MARGIN}px + var(--spacing) * 4)`;
		return {
			"--origin-width": `${origin + TEXT_MARGIN}px`,
			"--course-width": padded(origin + TEXT_MARGIN + 2 * time + arrow + destination + 4 * GAP),
			"--reference-width": padded(reference),
		} as React.CSSProperties;
	}, [groups, fontsLoaded]);
}

/** Les colonnes de l'export, dans l'ordre. */
const CSV_HEADER = [
	"Ligne",
	"Direction",
	"ID course",
	"Terminus de départ",
	"Départ",
	"Arrivée",
	"Terminus d'arrivée",
	"Arrêt de référence",
	"Heure de référence",
	"Motif",
	"Constatée à",
	"État",
	"Rétablie à",
	"Terminée",
];

/**
 * Toutes les courses non honorées de la journée en CSV — quels que soient l'onglet, la ligne et la
 * case des courses terminées —, telles que la page les a reçues. Le point-virgule et la marque d'ordre
 * UTF-8 sont ce qu'attend un tableur réglé en français : les colonnes s'y séparent, les accents s'y
 * lisent. Les heures de course sont celles du GTFS (« 25:10 »), celles des constats à l'heure locale.
 */
function downloadCsv(groups: MissedTripsDto["lines"]) {
	const rows = groups.flatMap((group) =>
		group.directions.flatMap((direction) =>
			direction.trips.map((trip) => [
				group.line.line,
				direction.headsigns.join(" / "),
				trip.tripId.split(":").at(-1) ?? trip.tripId,
				trip.origin,
				formatGtfsTime(trip.departure),
				formatGtfsTime(trip.arrival),
				trip.destination,
				trip.reference.name,
				formatGtfsTime(trip.reference.time),
				REASONS[trip.reason],
				formatClock(trip.detectedAt),
				trip.restoredAt === null ? "Supprimée" : "Rétablie",
				trip.restoredAt === null ? "" : formatClock(trip.restoredAt),
				trip.finished ? "oui" : "non",
			]),
		),
	);
	const field = (value: string) => (/[";\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
	const csv = [CSV_HEADER, ...rows].map((row) => row.map(field).join(";")).join("\r\n");

	const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = `courses-non-honorees-${new Date().toLocaleDateString("sv-SE")}.csv`;
	link.click();
	// Le téléchargement part du clic, mais certains navigateurs lisent l'adresse un instant après.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
