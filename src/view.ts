import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import Graph from "graphology";
import { Sigma } from "sigma";

export const VIEW_TYPE = "graph-workspace-view";

// Camera ratio thresholds — Sigma's ratio increases as you zoom *out*
const RATIO_LOW_ZOOM = 1.5;  // >= this: zoomed out → top ~10% labels only
const RATIO_HIGH_ZOOM = 0.75; // <= this: zoomed in   → show all labels
// Between the two: medium zoom → labels for degree > 1

// Node colour at degree = 0 (orphan) and at max degree (hub)
const COLOUR_ORPHAN = "#8899aa"; // muted blue-grey
const COLOUR_HUB = "#4a9edd";    // bright, slightly warm blue

export class GraphWorkspaceView extends ItemView {
	private sigma: InstanceType<typeof Sigma> | null = null;
	private cameraUpdatedHandler: (() => void) | null = null;
	private previewLeaf: WorkspaceLeaf | null = null;

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
		this.layoutNodes(graph);

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
			defaultEdgeColor: "#c8c8c8",
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
	 * Assign evenly-spaced positions on a unit circle with slight radial noise.
	 * Sigma handles zoom/pan from there; a force-layout is out of scope for Phase 1.
	 */
	private layoutNodes(graph: InstanceType<typeof Graph>): void {
		const count = graph.order;
		let i = 0;
		graph.forEachNode((node) => {
			const angle = (2 * Math.PI * i) / Math.max(count, 1);
			const r = 0.8 + Math.random() * 0.4;
			graph.setNodeAttribute(node, "x", r * Math.cos(angle));
			graph.setNodeAttribute(node, "y", r * Math.sin(angle));
			i++;
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
