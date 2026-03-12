import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import Graph from "graphology";
import { Sigma } from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import randomLayout from "graphology-layout/random";

export const VIEW_TYPE = "graph-workspace-view";

// Camera ratio thresholds — Sigma's ratio increases as you zoom *out*
const RATIO_LOW_ZOOM = 1.5;  // >= this: zoomed out → top ~10% labels only
const RATIO_HIGH_ZOOM = 0.75; // <= this: zoomed in   → show all labels
// Between the two: medium zoom → labels for degree > 1

// Node colour at degree = 0 (orphan) and at max degree (hub)
const COLOUR_ORPHAN = "#8899aa"; // muted blue-grey
const COLOUR_HUB = "#4a9edd";    // bright, slightly warm blue

interface LayoutSettings {
	iterations: number;
	scalingRatio: number;
	gravity: number;
}

export class GraphWorkspaceView extends ItemView {
	private sigma: InstanceType<typeof Sigma> | null = null;
	private cameraUpdatedHandler: (() => void) | null = null;
	private previewLeaf: WorkspaceLeaf | null = null;
	private settingsPanel: HTMLElement | null = null;
	private layoutSettings: LayoutSettings = {
		iterations: 500,
		scalingRatio: 10,
		gravity: 1,
	};

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Graph workspace";
	}

	getIcon(): string {
		return "git-fork";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();

		const graphEl = container.createDiv({ cls: "graph-workspace-container" });

		const graph = this.buildGraph();
		this.layoutNodes(graph, this.layoutSettings);

		// Precompute the top-~10%-by-degree threshold for low-zoom label hiding.
		const degrees: number[] = [];
		graph.forEachNode((node) => degrees.push(graph.degree(node)));
		degrees.sort((a, b) => b - a);
		const topCount = Math.max(1, Math.floor(degrees.length * 0.1));
		// Minimum degree a node must have to get a label when zoomed way out.
		// Always at least 1 so we never label isolated nodes at low zoom.
		const topDegreeThreshold = Math.max(1, degrees[topCount - 1] ?? 1);

		// Closed-over zoom state read by nodeReducer on every render.
		let currentRatio = 1;

		this.sigma = new Sigma(graph, graphEl, {
			renderEdgeLabels: false,
			labelColor: { color: "#dcddde" },
			defaultEdgeColor: "#4a4a4a",
			// Thin edges so they don't compete visually with nodes and labels.
			edgeReducer: (_edge, data) => ({ ...data, size: 0.5 }),
			// Zoom-dependent label visibility.
			nodeReducer: (node, data) => {
				const degree = graph.degree(node);
				let showLabel: boolean;

				if (currentRatio >= RATIO_LOW_ZOOM) {
					// Zoomed out: only hub nodes (top ~10% by degree).
					showLabel = degree >= topDegreeThreshold;
				} else if (currentRatio > RATIO_HIGH_ZOOM) {
					// Medium zoom: all connected nodes (degree > 1).
					showLabel = degree > 1;
				} else {
					// Zoomed in: everything.
					showLabel = true;
				}

				return showLabel ? data : { ...data, label: "" };
			},
		});

		// Update the closed-over ratio whenever the camera moves.
		// Sigma re-renders automatically after a camera update, so the next
		// nodeReducer call will see the fresh ratio without an explicit refresh().
		const camera = this.sigma.getCamera();
		this.cameraUpdatedHandler = () => {
			currentRatio = camera.ratio;
		};
		camera.on("updated", this.cameraUpdatedHandler);

		// Open a note preview in a split pane when a node is clicked.
		this.sigma.on("clickNode", ({ node }) => {
			void this.openPreview(node);
		});

		// Inject the settings panel overlay into the graph container.
		this.settingsPanel = this.buildSettingsPanel(graphEl, graph);
	}

	async onClose(): Promise<void> {
		if (this.sigma) {
			if (this.cameraUpdatedHandler) {
				this.sigma.getCamera().off("updated", this.cameraUpdatedHandler);
				this.cameraUpdatedHandler = null;
			}
			this.sigma.kill();
			this.sigma = null;
		}
		if (this.settingsPanel) {
			this.settingsPanel.remove();
			this.settingsPanel = null;
		}
	}

	/**
	 * Build and inject a collapsible settings panel overlay into the graph
	 * container. Returns the panel root element.
	 */
	private buildSettingsPanel(
		graphEl: HTMLElement,
		graph: InstanceType<typeof Graph>,
	): HTMLElement {
		const panel = graphEl.createDiv({ cls: "gw-settings-panel" });

		// ── Toggle button (gear icon) ──────────────────────────────────────────
		const toggleBtn = panel.createEl("button", {
			cls: "gw-settings-toggle",
			attr: { "aria-label": "Toggle graph settings", title: "Graph settings" },
		});
		// SVG gear icon (inline, no external dependency).
		const svgNS = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(svgNS, "svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("width", "16");
		svg.setAttribute("height", "16");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "2");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		const circle = document.createElementNS(svgNS, "circle");
		circle.setAttribute("cx", "12");
		circle.setAttribute("cy", "12");
		circle.setAttribute("r", "3");
		svg.appendChild(circle);
		const path = document.createElementNS(svgNS, "path");
		path.setAttribute("d", "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z");
		svg.appendChild(path);
		toggleBtn.appendChild(svg);

		// ── Body (collapsible) ─────────────────────────────────────────────────
		const body = panel.createDiv({ cls: "gw-settings-body" });

		// Helper: create a labelled slider row.
		const makeSlider = (
			label: string,
			min: number,
			max: number,
			step: number,
			value: number,
			onChange: (v: number) => void,
		): void => {
			const row = body.createDiv({ cls: "gw-settings-row" });
			const labelEl = row.createEl("label", { cls: "gw-settings-label" });
			const valueSpan = labelEl.createSpan({ cls: "gw-settings-value" });
			valueSpan.textContent = String(value);
			labelEl.prepend(label + "\u00a0"); // non-breaking space before value
			const input = row.createEl("input", {
				cls: "gw-settings-slider",
				attr: {
					type: "range",
					min: String(min),
					max: String(max),
					step: String(step),
					value: String(value),
				},
			});
			input.addEventListener("input", () => {
				const v = Number(input.value);
				valueSpan.textContent = String(v);
				onChange(v);
			});
		};

		makeSlider(
			"Layout iterations",
			50, 1000, 50,
			this.layoutSettings.iterations,
			(v) => { this.layoutSettings.iterations = v; },
		);
		makeSlider(
			"Spread",
			1, 50, 1,
			this.layoutSettings.scalingRatio,
			(v) => { this.layoutSettings.scalingRatio = v; },
		);
		makeSlider(
			"Gravity",
			0.1, 5, 0.1,
			this.layoutSettings.gravity,
			(v) => { this.layoutSettings.gravity = v; },
		);

		// ── Re-run layout button ───────────────────────────────────────────────
		const rerunBtn = body.createEl("button", {
			cls: "gw-settings-rerun",
			text: "Re-run layout",
		});
		rerunBtn.addEventListener("click", () => {
			if (!this.sigma) return;
			this.layoutNodes(graph, this.layoutSettings);
			this.sigma.refresh();
		});

		// ── Toggle behaviour ───────────────────────────────────────────────────
		let expanded = false;
		const setExpanded = (open: boolean) => {
			expanded = open;
			body.style.display = open ? "block" : "none";
			toggleBtn.classList.toggle("gw-settings-toggle--active", open);
		};
		setExpanded(false); // start collapsed

		toggleBtn.addEventListener("click", () => setExpanded(!expanded));

		return panel;
	}

	/**
	 * Open the note at `path` in a split-pane preview leaf.
	 * Reuses the existing preview leaf if one is still open, to avoid
	 * proliferating tabs. Silently no-ops if the same file is already shown.
	 */
	private async openPreview(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;

		if (this.previewLeaf) {
			const view = this.previewLeaf.view;
			// If this exact file is already displayed, do nothing.
			if (view instanceof MarkdownView && view.file?.path === path) {
				return;
			}
			// Otherwise navigate the existing leaf to the new file.
			try {
				await this.previewLeaf.openFile(file);
				return;
			} catch {
				// The leaf was closed by the user — fall through and create a new one.
				this.previewLeaf = null;
			}
		}

		// Open a vertical split alongside the current view, keeping the graph stable.
		this.previewLeaf = this.app.workspace.getLeaf("split");
		await this.previewLeaf.openFile(file);
	}

	private buildGraph(): InstanceType<typeof Graph> {
		const graph = new Graph({ multi: false, type: "directed" });

		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		const allFiles = this.app.vault.getMarkdownFiles();

		// Add every markdown file as a node.
		for (const file of allFiles) {
			if (!graph.hasNode(file.path)) {
				graph.addNode(file.path, {
					label: file.basename,
					x: 0,
					y: 0,
					size: 4,
					color: COLOUR_ORPHAN,
				});
			}
		}

		// Add edges from resolvedLinks (source → target).
		for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
			if (!graph.hasNode(sourcePath)) {
				graph.addNode(sourcePath, {
					label: sourcePath,
					x: 0,
					y: 0,
					size: 4,
					color: COLOUR_ORPHAN,
				});
			}
			for (const targetPath of Object.keys(targets)) {
				if (!graph.hasNode(targetPath)) {
					graph.addNode(targetPath, {
						label: targetPath,
						x: 0,
						y: 0,
						size: 4,
						color: COLOUR_ORPHAN,
					});
				}
				if (!graph.hasEdge(sourcePath, targetPath)) {
					graph.addEdge(sourcePath, targetPath);
				}
			}
		}

		// Compute max degree for normalised logarithmic scaling.
		let maxDegree = 0;
		graph.forEachNode((node) => {
			maxDegree = Math.max(maxDegree, graph.degree(node));
		});
		const maxLogDegree = Math.log1p(maxDegree);

		// Apply logarithmic size and interpolated colour to each node.
		// Logarithmic scale handles the power-law distribution of link graphs
		// far better than linear: hub nodes stand out without becoming enormous.
		graph.forEachNode((node) => {
			const degree = graph.degree(node);
			const t = maxLogDegree > 0 ? Math.log1p(degree) / maxLogDegree : 0;

			// Size: 3 px (orphan) → 17 px (max-degree hub).
			const size = 3 + t * 14;

			// Colour: interpolate between orphan grey-blue and hub bright-blue.
			const color = interpolateHex(COLOUR_ORPHAN, COLOUR_HUB, t);

			graph.setNodeAttribute(node, "size", size);
			graph.setNodeAttribute(node, "color", color);
		});

		return graph;
	}

	/**
	 * Apply a force-directed layout using ForceAtlas2.
	 * Random positions are assigned first (required by ForceAtlas2), then the
	 * algorithm runs synchronously for the requested number of iterations so
	 * that connected notes cluster naturally before Sigma renders.
	 */
	private layoutNodes(
		graph: InstanceType<typeof Graph>,
		settings: LayoutSettings,
	): void {
		// ForceAtlas2 requires existing positions — seed with random layout.
		randomLayout.assign(graph);

		forceAtlas2.assign(graph, {
			iterations: settings.iterations,
			settings: {
				gravity: settings.gravity,
				scalingRatio: settings.scalingRatio,
				barnesHutOptimize: true,
			},
		});
	}
}

/** Linear interpolation between two 6-digit hex colours. */
function interpolateHex(a: string, b: string, t: number): string {
	const rA = parseInt(a.slice(1, 3), 16);
	const gA = parseInt(a.slice(3, 5), 16);
	const bA = parseInt(a.slice(5, 7), 16);
	const rB = parseInt(b.slice(1, 3), 16);
	const gB = parseInt(b.slice(3, 5), 16);
	const bB = parseInt(b.slice(5, 7), 16);
	const r = Math.round(rA + (rB - rA) * t).toString(16).padStart(2, "0");
	const g = Math.round(gA + (gB - gA) * t).toString(16).padStart(2, "0");
	const bl = Math.round(bA + (bB - bA) * t).toString(16).padStart(2, "0");
	return `#${r}${g}${bl}`;
}
