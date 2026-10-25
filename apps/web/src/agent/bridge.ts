/**
 * Agent bridge: a small, JSON-friendly API on `window.opencut` that lets an AI
 * assistant (e.g. Claude, driving the browser tab) read and edit the open
 * project alongside the person using the editor.
 *
 * Every edit goes through the same managers and commands the UI uses, so
 * changes show up live and can be undone with Ctrl/Cmd+Z like any other edit.
 *
 * All times in this API are in seconds. Element and track IDs come from
 * `opencut.state()`.
 */
import type { EditorCore } from "@/core";
import type {
	ElementRef,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	TrackType,
} from "@/timeline";
import type { ParamValues } from "@/params";
import {
	buildElementFromMedia,
	buildTextElement,
} from "@/timeline/element-utils";
import { DEFAULTS } from "@/timeline/defaults";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { buildConstantRetime } from "@/retime";
import { clampRetimeRate, DEFAULT_RETIME_RATE } from "@/retime/rate";
import { processMediaAssets } from "@/media/processing";
import { AddMediaAssetCommand } from "@/commands/media";
import { InsertElementCommand } from "@/commands/timeline";
import { BatchCommand } from "@/commands";
import {
	type MediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
} from "@/wasm";
import { generateUUID } from "@/utils/id";

const BRIDGE_VERSION = 1;

type TrackKind = "main" | "overlay" | "audio";

interface Located {
	track: TimelineTrack;
	kind: TrackKind;
	element: TimelineElement;
}

function sec(time: MediaTime | undefined): number | undefined {
	if (time === undefined) return undefined;
	return Math.round(mediaTimeToSeconds({ time }) * 1000) / 1000;
}

function toTime(seconds: number, label = "time"): MediaTime {
	if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
		throw new Error(`${label} must be a number of seconds`);
	}
	return mediaTimeFromSeconds({ seconds: Math.max(0, seconds) });
}

function rateOf(element: TimelineElement): number {
	const retime = "retime" in element ? element.retime : undefined;
	return retime?.rate ?? DEFAULT_RETIME_RATE;
}

function listTracks(
	tracks: SceneTracks,
): Array<{ track: TimelineTrack; kind: TrackKind }> {
	return [
		...tracks.overlay.map((track) => ({ track, kind: "overlay" as const })),
		{ track: tracks.main, kind: "main" as const },
		...tracks.audio.map((track) => ({ track, kind: "audio" as const })),
	];
}

export function createAgentBridge(editor: EditorCore) {
	const scene = () => {
		const active = editor.scenes.getActiveSceneOrNull();
		if (!active) {
			throw new Error(
				"No project is open. Open or create a project in the editor first.",
			);
		}
		return active;
	};

	const project = () => {
		const active = editor.project.getActive();
		if (!active) throw new Error("No project is open.");
		return active;
	};

	const find = (elementId: string): Located => {
		for (const { track, kind } of listTracks(scene().tracks)) {
			const element = track.elements.find((el) => el.id === elementId);
			if (element) return { track, kind, element };
		}
		throw new Error(`Element not found: ${elementId}`);
	};

	const describeElement = (element: TimelineElement) => {
		const start = sec(element.startTime) ?? 0;
		const duration = sec(element.duration) ?? 0;
		const params = element.params as Record<string, unknown>;
		return {
			id: element.id,
			type: element.type,
			name: element.name,
			start,
			end: Math.round((start + duration) * 1000) / 1000,
			duration,
			trimStart: sec(element.trimStart),
			trimEnd: sec(element.trimEnd),
			sourceDuration: sec(element.sourceDuration),
			mediaId: "mediaId" in element ? element.mediaId : undefined,
			speed: rateOf(element) !== 1 ? rateOf(element) : undefined,
			text: element.type === "text" ? params.content : undefined,
			hidden: "hidden" in element ? element.hidden : undefined,
		};
	};

	const api = {
		version: BRIDGE_VERSION,

		help(): string {
			return [
				"window.opencut — all times are in seconds.",
				"state()                                  project, assets, tracks, elements, playhead, selection",
				"element(id)                              full raw element (params included)",
				"seek(t) / play() / pause()",
				"addMedia({ assetId, at?, trackType? })   put an imported asset on the timeline",
				"importFromUrl({ url, name?, at?, addToTimeline? })",
				"addText({ text, at?, duration?, fontSize?, color?, x?, y?, params? })",
				"split({ at, elementIds? })               split clips under the playhead time (default: all)",
				"trim({ elementId, start?, end? })        set new timeline start/end of a clip",
				"move({ elementId, to })                  move a clip to a new start time (same track)",
				"                                         note: the first clip on the main track always snaps to 0",
				"remove({ elementIds })",
				"removeRange({ from, to })                cut a time range out of every track and close the gap",
				"setParams({ elementId, params })         e.g. { content, fontSize, color, volume, opacity, 'transform.positionY' }",
				"setSpeed({ elementId, rate, maintainPitch? })",
				"select({ elementIds }) / undo() / redo()",
			].join("\n");
		},

		state() {
			const proj = project();
			const tracks = scene().tracks;
			return {
				project: {
					name: proj.metadata.name,
					fps: proj.settings.fps,
					canvas: proj.settings.canvasSize,
				},
				playhead: sec(editor.playback.getCurrentTime()),
				duration: sec(editor.timeline.getTotalDuration()),
				isPlaying: editor.playback.getIsPlaying(),
				assets: editor.media.getAssets().map((asset) => ({
					id: asset.id,
					name: asset.name,
					type: asset.type,
					duration: asset.duration,
					width: asset.width,
					height: asset.height,
				})),
				tracks: listTracks(tracks).map(({ track, kind }) => ({
					id: track.id,
					kind,
					type: track.type,
					muted: "muted" in track ? track.muted : undefined,
					hidden: "hidden" in track ? track.hidden : undefined,
					elements: [...track.elements]
						.sort((a, b) => a.startTime - b.startTime)
						.map(describeElement),
				})),
				selection: editor.selection
					.getSelectedElements()
					.map((ref) => ref.elementId),
				canUndo: editor.command.canUndo(),
				canRedo: editor.command.canRedo(),
			};
		},

		element(elementId: string) {
			return structuredClone(find(elementId).element);
		},

		seek(seconds: number) {
			editor.playback.seek({ time: toTime(seconds) });
			return sec(editor.playback.getCurrentTime());
		},

		play() {
			editor.playback.play();
		},

		pause() {
			editor.playback.pause();
		},

		addMedia({
			assetId,
			at,
			trackType,
		}: {
			assetId: string;
			at?: number;
			trackType?: TrackType;
		}) {
			const asset = editor.media.getAssets().find((a) => a.id === assetId);
			if (!asset) throw new Error(`Asset not found: ${assetId}`);
			const before = new Set(api._allElementIds());
			const element = buildElementFromMedia({
				mediaId: asset.id,
				mediaType: asset.type,
				name: asset.name,
				duration:
					asset.duration != null
						? mediaTimeFromSeconds({ seconds: asset.duration })
						: DEFAULT_NEW_ELEMENT_DURATION,
				startTime:
					at === undefined ? editor.playback.getCurrentTime() : toTime(at),
			});
			editor.timeline.insertElement({
				element,
				placement: { mode: "auto", trackType },
			});
			return api._newElementIds(before);
		},

		async importFromUrl({
			url,
			name,
			at,
			addToTimeline = true,
		}: {
			url: string;
			name?: string;
			at?: number;
			addToTimeline?: boolean;
		}) {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`Download failed: ${response.status} ${url}`);
			}
			const blob = await response.blob();
			const fileName =
				name ?? decodeURIComponent(new URL(url).pathname.split("/").pop() || "media");
			const file = new File([blob], fileName, { type: blob.type });
			const [asset] = await processMediaAssets({ files: [file] });
			if (!asset) throw new Error("Unsupported media file");

			const addMediaCmd = new AddMediaAssetCommand({
				projectId: project().metadata.id,
				asset,
			});
			const before = new Set(api._allElementIds());
			if (!addToTimeline) {
				editor.command.execute({ command: addMediaCmd });
				return { assetId: addMediaCmd.getAssetId(), elementIds: [] };
			}

			const element = buildElementFromMedia({
				mediaId: addMediaCmd.getAssetId(),
				mediaType: asset.type,
				name: asset.name,
				duration:
					asset.duration != null
						? mediaTimeFromSeconds({ seconds: asset.duration })
						: DEFAULT_NEW_ELEMENT_DURATION,
				startTime:
					at === undefined ? editor.playback.getCurrentTime() : toTime(at),
				buffer:
					asset.type === "audio"
						? new AudioBuffer({ length: 1, sampleRate: 44100 })
						: undefined,
			});
			const insertCmd = new InsertElementCommand({
				element,
				placement: {
					mode: "auto",
					trackType: asset.type === "audio" ? "audio" : "video",
				},
			});
			editor.command.execute({
				command: new BatchCommand([addMediaCmd, insertCmd]),
			});
			return {
				assetId: addMediaCmd.getAssetId(),
				elementIds: api._newElementIds(before),
			};
		},

		addText({
			text,
			at,
			duration,
			fontSize,
			color,
			x,
			y,
			params,
		}: {
			text: string;
			at?: number;
			duration?: number;
			fontSize?: number;
			color?: string;
			x?: number;
			y?: number;
			params?: Partial<ParamValues>;
		}) {
			const before = new Set(api._allElementIds());
			const overrides: Record<string, unknown> = { content: text };
			if (fontSize !== undefined) overrides.fontSize = fontSize;
			if (color !== undefined) overrides.color = color;
			if (x !== undefined) overrides["transform.positionX"] = x;
			if (y !== undefined) overrides["transform.positionY"] = y;
			const element = buildTextElement({
				raw: {
					...DEFAULTS.text.element,
					...(duration !== undefined && {
						duration: toTime(duration, "duration"),
					}),
					params: {
						...DEFAULTS.text.element.params,
						...overrides,
						...(params ?? {}),
					} as ParamValues,
				},
				startTime:
					at === undefined ? editor.playback.getCurrentTime() : toTime(at),
			});
			editor.timeline.insertElement({
				element,
				placement: { mode: "auto" },
			});
			return api._newElementIds(before);
		},

		split({ at, elementIds }: { at: number; elementIds?: string[] }) {
			const time = toTime(at);
			const targets: ElementRef[] = [];
			for (const { track } of listTracks(scene().tracks)) {
				for (const el of track.elements) {
					if (elementIds && !elementIds.includes(el.id)) continue;
					const end = el.startTime + el.duration;
					if (time > el.startTime && time < end) {
						targets.push({ trackId: track.id, elementId: el.id });
					}
				}
			}
			if (targets.length === 0) return [];
			return editor.timeline
				.splitElements({ elements: targets, splitTime: time })
				.map((ref) => ref.elementId);
		},

		trim({
			elementId,
			start,
			end,
		}: {
			elementId: string;
			start?: number;
			end?: number;
		}) {
			const { element } = find(elementId);
			const rate = rateOf(element);
			const hasSource = element.sourceDuration !== undefined;
			let startTime: number = element.startTime;
			let duration: number = element.duration;
			let trimStart: number = element.trimStart;
			let trimEnd: number = element.trimEnd;

			if (start !== undefined) {
				let delta = toTime(start, "start") - startTime;
				if (hasSource) delta = Math.max(delta, -trimStart / rate);
				delta = Math.min(delta, duration - 1);
				startTime += delta;
				duration -= delta;
				if (hasSource) trimStart += delta * rate;
			}
			if (end !== undefined) {
				let delta = startTime + duration - toTime(end, "end");
				if (hasSource) delta = Math.max(delta, -trimEnd / rate);
				delta = Math.min(delta, duration - 1);
				duration -= delta;
				if (hasSource) trimEnd += delta * rate;
			}

			editor.timeline.updateElementTrim({
				elementId,
				trimStart: roundMediaTime({ time: Math.max(0, trimStart) }),
				trimEnd: roundMediaTime({ time: Math.max(0, trimEnd) }),
				startTime: roundMediaTime({ time: startTime }),
				duration: roundMediaTime({ time: duration }),
			});
			return describeElement(find(elementId).element);
		},

		move({ elementId, to }: { elementId: string; to: number }) {
			const { track } = find(elementId);
			editor.timeline.updateElements({
				updates: [
					{
						trackId: track.id,
						elementId,
						patch: { startTime: toTime(to, "to") },
					},
				],
			});
			return describeElement(find(elementId).element);
		},

		remove({ elementIds }: { elementIds: string[] }) {
			const refs = elementIds.map((id) => ({
				trackId: find(id).track.id,
				elementId: id,
			}));
			editor.timeline.deleteElements({ elements: refs });
		},

		removeRange({ from, to }: { from: number; to: number }) {
			if (!(to > from)) throw new Error("`to` must be greater than `from`");
			const fromT = toTime(from, "from");
			const toT = toTime(to, "to");
			const gap = toT - fromT;

			const tracks = structuredClone(scene().tracks) as SceneTracks;
			const cutTrack = <T extends TimelineTrack>(track: T): T => {
				const next: TimelineElement[] = [];
				for (const el of track.elements) {
					const rate = rateOf(el);
					const hasSource = el.sourceDuration !== undefined;
					const s = el.startTime as number;
					const e = s + (el.duration as number);
					if (e <= fromT) {
						next.push(el);
					} else if (s >= toT) {
						next.push({ ...el, startTime: roundMediaTime({ time: s - gap }) });
					} else if (s >= fromT && e <= toT) {
						// fully inside the cut: drop it
					} else if (s < fromT && e > toT) {
						// spans the cut: keep the left part, push a right part after the gap
						const leftDur = fromT - s;
						const rightDur = e - toT;
						const left = {
							...el,
							duration: roundMediaTime({ time: leftDur }),
							trimEnd: hasSource
								? roundMediaTime({ time: (el.trimEnd as number) + (e - fromT) * rate })
								: el.trimEnd,
						};
						const right = {
							...el,
							id: generateUUID(),
							startTime: roundMediaTime({ time: fromT }),
							duration: roundMediaTime({ time: rightDur }),
							trimStart: hasSource
								? roundMediaTime({ time: (el.trimStart as number) + (toT - s) * rate })
								: el.trimStart,
						};
						next.push(left as TimelineElement, right as TimelineElement);
					} else if (s < fromT) {
						// overlaps the start of the cut: trim its end
						const newDur = fromT - s;
						next.push({
							...el,
							duration: roundMediaTime({ time: newDur }),
							trimEnd: hasSource
								? roundMediaTime({ time: (el.trimEnd as number) + (e - fromT) * rate })
								: el.trimEnd,
						} as TimelineElement);
					} else {
						// overlaps the end of the cut: trim its start, shift into place
						const cut = toT - s;
						next.push({
							...el,
							startTime: roundMediaTime({ time: fromT }),
							duration: roundMediaTime({ time: e - toT }),
							trimStart: hasSource
								? roundMediaTime({ time: (el.trimStart as number) + cut * rate })
								: el.trimStart,
						} as TimelineElement);
					}
				}
				return { ...track, elements: next } as T;
			};

			editor.timeline.updateTracks({
				overlay: tracks.overlay.map(cutTrack),
				main: cutTrack(tracks.main),
				audio: tracks.audio.map(cutTrack),
			});
			return sec(editor.timeline.getTotalDuration());
		},

		setParams({
			elementId,
			params,
		}: {
			elementId: string;
			params: Partial<ParamValues>;
		}) {
			const { track, element } = find(elementId);
			editor.timeline.updateElements({
				updates: [
					{
						trackId: track.id,
						elementId,
						patch: {
							params: { ...element.params, ...params } as ParamValues,
						},
					},
				],
			});
			return api.element(elementId).params;
		},

		setSpeed({
			elementId,
			rate,
			maintainPitch = false,
		}: {
			elementId: string;
			rate: number;
			maintainPitch?: boolean;
		}) {
			const { track, element } = find(elementId);
			if (element.type !== "video" && element.type !== "audio") {
				throw new Error("Speed can only be changed on video or audio clips");
			}
			const clamped = clampRetimeRate({ rate });
			editor.timeline.updateElementRetime({
				trackId: track.id,
				elementId,
				retime:
					clamped === DEFAULT_RETIME_RATE && !maintainPitch
						? undefined
						: buildConstantRetime({ rate: clamped, maintainPitch }),
			});
			return describeElement(find(elementId).element);
		},

		select({ elementIds }: { elementIds: string[] }) {
			editor.selection.setSelectedElements({
				elements: elementIds.map((id) => ({
					trackId: find(id).track.id,
					elementId: id,
				})),
			});
		},

		undo() {
			editor.command.undo();
		},

		redo() {
			editor.command.redo();
		},

		_allElementIds(): string[] {
			const active = editor.scenes.getActiveSceneOrNull();
			if (!active) return [];
			return listTracks(active.tracks).flatMap(({ track }) =>
				track.elements.map((el) => el.id),
			);
		},

		_newElementIds(before: Set<string>): string[] {
			return api._allElementIds().filter((id) => !before.has(id));
		},
	};

	return api;
}

export type AgentBridge = ReturnType<typeof createAgentBridge>;

declare global {
	interface Window {
		opencut?: AgentBridge;
	}
}

export function installAgentBridge(editor: EditorCore): void {
	if (typeof window === "undefined") return;
	window.opencut = createAgentBridge(editor);
}
