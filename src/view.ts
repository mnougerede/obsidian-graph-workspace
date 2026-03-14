import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import Graph from "graphology";
import { Sigma } from "sigma";
import {
	forceSimulation,
	forceLink,
	forceManyBody,
	forceCenter,
	forceCollide,
	Simulation,
	SimulationNodeDatum,
	SimulationLinkDatum,
	ForceManyBody,
	ForceLink,
	ForceCenter,
	ForceCollide,
} from "d3-force";
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
	chargeStrength: number;   // forceManyBody.strength
	linkDistance: number;     // forceLink.distance
	centerStrength: number;   // forceCenter.strength
	collideRadius: number;    // forceCollide padding added to node size
}

interface SimNode extends SimulationNodeDatum {
	id: string;
	size: number;
	[key: string]: unknown;
}

export class GraphWorkspaceView extends ItemView {
	private sigma: InstanceType<typeof Sigma> | null = null;
	private simulation: Simulation<SimNode, SimulationLinkDatum<SimNode>> | null = null;
	private simulationRunning = false;
	private graph: InstanceType<typeof Graph> | null = null;
	private cameraUpdatedHandler: (() => void) | null = null;
	private previewLeaf: WorkspaceLeaf | null = null;
	private settingsPanel: HTMLElement | null = null;
	private layoutSettings: LayoutSettings = {
		chargeStrength: -150,
		linkDistance: 80,
		centerStrength: 0.03,
		collideRadius: 2,
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
		// Guard: stop any previous simulation before re-initialising.
		if (this.simulation) {
			this.simulation.stop();
			this.simulation = null;
		}

		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();

		const graphEl = container.createDiv({ cls: "graph-workspace-container" });

		this.graph = this.buildGraph();
		const graph = this.graph;

		// Seed positions so d3-force has a sensible starting point.
		randomLayout.assign(graph);

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
		const camera = this.sigma.getCamera();
		this.cameraUpdatedHandler = () => {
			currentRatio = camera.ratio;
		};
		camera.on("updated", this.cameraUpdatedHandler);

		// Open a note preview in a split pane when a node is clicked.
		this.sigma.removeAllListeners("clickNode");
		this.sigma.on("clickNode", ({ node }) => {
			void this.openPreview(node);
		});

		// Build d3 node and link arrays from the Graphology graph.
		// Deliberately omit x/y from the spread so d3 owns those properties
		// entirely. If the existing Graphology x/y values were spread in,
		// d3 treats them as already-settled positions and barely moves nodes
		// when forces change — making sliders appear to have no effect.
		const simNodes: SimNode[] = graph.nodes().map(n => {
			const attrs = graph.getNodeAttributes(n) as { size: number; label?: string; x?: number; y?: number; [key: string]: unknown };
			return {
				id: n,
				size: attrs.size,
				label: attrs.label,
			};
		});

		const simLinks: SimulationLinkDatum<SimNode>[] = graph.edges().map(e => ({
			source: graph.source(e),
			target: graph.target(e),
		}));

		// Create the d3-force simulation. All forces run on the main thread via
		// d3-timer (requestAnimationFrame-backed), keeping the UI responsive.
		// alphaDecay slows cooling so sliders have more time to take effect;
		// alphaMin sets the threshold at which the simulation stops naturally.
		this.simulation = forceSimulation<SimNode>(simNodes)
			.alphaDecay(0.01)
			.alphaMin(0.001)
			.force("link", forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
				.id((d) => d.id)
				.distance(this.layoutSettings.linkDistance)
				.strength(0.3))
			.force("charge", forceManyBody<SimNode>()
				.strength(this.layoutSettings.chargeStrength))
			.force("center", forceCenter<SimNode>(0, 0)
				.strength(this.layoutSettings.centerStrength))
			.force("collide", forceCollide<SimNode>()
				.radius((d) => d.size + this.layoutSettings.collideRadius));

		this.simulationRunning = true;

		// On each tick, write positions back to Graphology so Sigma picks them up.
		this.simulation.on("tick", () => {
			simNodes.forEach(node => {
				graph.setNodeAttribute(node.id, "x", node.x ?? 0);
				graph.setNodeAttribute(node.id, "y", node.y ?? 0);
			});
			this.sigma?.refresh();
		});

		// Track when the simulation naturally decays to a stop.
		this.simulation.on("end", () => {
			this.simulationRunning = false;
		});

		// Inject the settings panel overlay into the graph container.
		this.settingsPanel = this.buildSettingsPanel(graphEl);
	}

	async onClose(): Promise<void> {
		if (this.simulation) {
			this.simulation.stop();
			this.simulation = null;
		}
		this.simulationRunning = false;
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

		// Declare the button reference early so syncBtn and reheat can close over it.
		let layoutBtn!: HTMLButtonElement;

		// Sync button label to actual running state.
		const syncBtn = () => {
			layoutBtn.textContent = this.simulationRunning ? "Stop layout" : "Start layout";
		};

		// Update a specific force in-place, then reheat the simulation so the
		// change is immediately visible without rebuilding from scratch.
		const reheat = () => {
			if (!this.simulation) return;
			console.debug("[reheat] alpha BEFORE:", this.simulation.alpha(), "simulationRunning:", this.simulationRunning);
			this.simulation.alpha(0.5).restart();
			console.debug("[reheat] alpha AFTER:", this.simulation.alpha(), "simulationRunning:", this.simulationRunning);
			this.simulationRunning = true;
			syncBtn();
		};

		// ── d3-force sliders ───────────────────────────────────────────────────
		makeSlider(
			"Repulsion",
			-300, -10, 10,
			this.layoutSettings.chargeStrength,
			(v) => {
				console.debug("[repulsion onChange] v:", v, "simulation truthy:", !!this.simulation, "charge force:", this.simulation?.force("charge"));
				this.layoutSettings.chargeStrength = v;
				this.simulation?.force<ForceManyBody<SimNode>>("charge")?.strength(v);
				reheat();
			},
		);
		makeSlider(
			"Link distance",
			20, 200, 10,
			this.layoutSettings.linkDistance,
			(v) => {
				this.layoutSettings.linkDistance = v;
				this.simulation?.force<ForceLink<SimNode, SimulationLinkDatum<SimNode>>>("link")?.distance(v);
				reheat();
			},
		);
		makeSlider(
			"Centring",
			0.005, 0.2, 0.005,
			this.layoutSettings.centerStrength,
			(v) => {
				this.layoutSettings.centerStrength = v;
				this.simulation?.force<ForceCenter<SimNode>>("center")?.strength(v);
				reheat();
			},
		);
		makeSlider(
			"Node spacing",
			0, 10, 0.5,
			this.layoutSettings.collideRadius,
			(v) => {
				this.layoutSettings.collideRadius = v;
				this.simulation?.force<ForceCollide<SimNode>>("collide")?.radius((d) => d.size + v);
				reheat();
			},
		);

		// ── Start / Stop layout toggle (appended after sliders) ───────────────
		layoutBtn = body.createEl("button", {
			cls: "gw-settings-rerun",
			text: "Stop layout",
		});
		layoutBtn.addEventListener("click", () => {
			if (!this.simulation) return;
			if (this.simulationRunning) {
				this.simulation.stop();
				this.simulationRunning = false;
			} else {
				this.simulation.alpha(0.5).restart();
				this.simulationRunning = true;
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

		// Poll every 500 ms to keep button label in sync with natural decay.
		const syncInterval = setInterval(() => {
			if (!this.simulation) { clearInterval(syncInterval); return; }
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
			const size = 2 + t * 6;

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
