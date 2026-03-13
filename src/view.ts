import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import Graph from "graphology";
import { Sigma } from "sigma";
import FA2Layout from "graphology-layout-forceatlas2/worker";
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
	gravity: number;
	scalingRatio: number;
	strongGravityMode: boolean;
	edgeWeightInfluence: number;
}

export class GraphWorkspaceView extends ItemView {
	private sigma: InstanceType<typeof Sigma> | null = null;
	private layout: InstanceType<typeof FA2Layout> | null = null;
	private graph: InstanceType<typeof Graph> | null = null;
	private cameraUpdatedHandler: (() => void) | null = null;
	private previewLeaf: WorkspaceLeaf | null = null;
	private settingsPanel: HTMLElement | null = null;
	private layoutSettings: LayoutSettings = {
		gravity: 0.5,
		scalingRatio: 20,
		strongGravityMode: true,
		edgeWeightInfluence: 1,
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

		this.graph = this.buildGraph();
		const graph = this.graph;

		// Seed positions so FA2 has a starting point.
		randomLayout.assign(graph);

		// Place orphans (degree-0 nodes) in a fixed ring outside the main
		// cluster before FA2 starts. Marking them fixed means FA2 ignores them
		// entirely — they have no edges to drive their placement anyway.
		const orphanNodes = graph.nodes().filter(n => graph.degree(n) === 0);
		const orphanRadius = 500;
		const angleStep = (2 * Math.PI) / Math.max(1, orphanNodes.length);
		orphanNodes.forEach((node, i) => {
			const angle = i * angleStep;
			graph.setNodeAttribute(node, "x", orphanRadius * Math.cos(angle));
			graph.setNodeAttribute(node, "y", orphanRadius * Math.sin(angle));
			graph.setNodeAttribute(node, "fixed", true);
		});

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
			renderLabels: true,
			labelSize: 12,
			labelWeight: "normal",
			labelColor: { color: "#dcddde" },
			defaultEdgeColor: "#6e6e6e",
			defaultEdgeType: "line",
			renderEdgeLabels: false,
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
		// Guard against duplicate registrations if onOpen() is called more than once.
		this.sigma.removeAllListeners("clickNode");
		this.sigma.on("clickNode", ({ node }) => {
			void this.openPreview(node);
		});

		// Start the FA2 web-worker layout — runs off the main thread so the UI
		// stays responsive while the graph animates into a settled position.
		this.layout = new FA2Layout(graph, {
			settings: {
				gravity: this.layoutSettings.gravity,
				scalingRatio: this.layoutSettings.scalingRatio,
				strongGravityMode: this.layoutSettings.strongGravityMode,
				edgeWeightInfluence: this.layoutSettings.edgeWeightInfluence,
				barnesHutOptimize: true,
				slowDown: 5,
			},
		});
		this.layout.start();

		// Auto-stop after 3 s once the layout has settled.
		setTimeout(() => {
			if (this.layout?.isRunning()) this.layout.stop();
		}, 3000);

		// Inject the settings panel overlay into the graph container.
		this.settingsPanel = this.buildSettingsPanel(graphEl);
	}

	async onClose(): Promise<void> {
		if (this.layout) {
			this.layout.stop();
			this.layout.kill();
			this.layout = null;
		}
		this.graph = null;
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
	private buildSettingsPanel(graphEl: HTMLElement): HTMLElement {
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

		// Declare the button reference early so syncBtn and restartLayout can
		// close over it; the DOM element is appended below after the sliders.
		// The definite-assignment assertion (!) is safe: all uses of layoutBtn
		// are inside event handlers that fire only after this function returns.
		let layoutBtn!: HTMLButtonElement;

		// Sync button label to actual running state.
		const syncBtn = () => {
			layoutBtn.textContent = this.layout?.isRunning() ? "Stop layout" : "Start layout";
		};

		// When a setting changes: kill the current layout, recreate with updated
		// settings, and restart so the new parameters take effect immediately.
		const restartLayout = () => {
			if (!this.graph) return;
			if (this.layout) {
				this.layout.stop();
				this.layout.kill();
			}
			this.layout = new FA2Layout(this.graph, {
				settings: {
					gravity: this.layoutSettings.gravity,
					scalingRatio: this.layoutSettings.scalingRatio,
					strongGravityMode: this.layoutSettings.strongGravityMode,
					edgeWeightInfluence: this.layoutSettings.edgeWeightInfluence,
					barnesHutOptimize: true,
					slowDown: 5,
				},
			});
			this.layout.start();
			syncBtn();
		};

		// Helper: create a labelled checkbox toggle row.
		const makeToggle = (
			label: string,
			value: boolean,
			onChange: (v: boolean) => void,
		): void => {
			const row = body.createDiv({ cls: "gw-settings-row gw-settings-row--toggle" });
			const labelEl = row.createEl("label", { cls: "gw-settings-label" });
			labelEl.textContent = label;
			const input = row.createEl("input", {
				cls: "gw-settings-checkbox",
				attr: { type: "checkbox" },
			});
			input.checked = value;
			input.addEventListener("change", () => {
				onChange(input.checked);
			});
		};

		makeSlider(
			"Spread",
			1, 50, 1,
			this.layoutSettings.scalingRatio,
			(v) => {
				this.layoutSettings.scalingRatio = v;
				restartLayout();
			},
		);
		makeSlider(
			"Gravity",
			0.1, 5, 0.1,
			this.layoutSettings.gravity,
			(v) => {
				this.layoutSettings.gravity = v;
				restartLayout();
			},
		);
		makeSlider(
			"Cluster tightness",
			0, 2, 0.1,
			this.layoutSettings.edgeWeightInfluence,
			(v) => {
				this.layoutSettings.edgeWeightInfluence = v;
				restartLayout();
			},
		);
		makeToggle(
			"Strong gravity",
			this.layoutSettings.strongGravityMode,
			(v) => {
				this.layoutSettings.strongGravityMode = v;
				restartLayout();
			},
		);

		// ── Start / Stop layout toggle (appended after sliders) ───────────────
		layoutBtn = body.createEl("button", {
			cls: "gw-settings-rerun",
			text: "Stop layout",
		});
		layoutBtn.addEventListener("click", () => {
			if (!this.layout) return;
			if (this.layout.isRunning()) {
				this.layout.stop();
			} else {
				this.layout.start();
			}
			syncBtn();
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

		// Poll every 500 ms to keep button label in sync with the auto-stop timer.
		const syncInterval = setInterval(() => {
			if (!this.layout) { clearInterval(syncInterval); return; }
			syncBtn();
		}, 500);

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
			// A null parent means the leaf has been detached from the workspace
			// (e.g. the user closed the split pane). Treat it as gone so we don't
			// hold a stale reference that silently fails on openFile().
			if (!this.previewLeaf.parent) {
				this.previewLeaf = null;
			}
		}

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
			} catch (e) {
				// The leaf became invalid — fall through and create a new one.
				console.error("Graph Workspace: failed to reuse preview leaf", e);
				this.previewLeaf = null;
			}
		}

		// Open a vertical split alongside the current view, keeping the graph stable.
		try {
			this.previewLeaf = this.app.workspace.getLeaf("split");
			await this.previewLeaf.openFile(file);
		} catch (e) {
			console.error("Graph Workspace: failed to open file in preview", e);
			this.previewLeaf = null;
		}
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
