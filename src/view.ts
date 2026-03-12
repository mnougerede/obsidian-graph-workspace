import { ItemView, WorkspaceLeaf } from "obsidian";
import Graph from "graphology";
import { Sigma } from "sigma";

export const VIEW_TYPE = "graph-workspace-view";

export class GraphWorkspaceView extends ItemView {
	private sigma: InstanceType<typeof Sigma> | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Graph Workspace";
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
		this.sigma = new Sigma(graph, graphEl, {
			renderEdgeLabels: false,
			defaultNodeColor: "#6c8ebf",
			defaultEdgeColor: "#aaaaaa",
		});
	}

	async onClose(): Promise<void> {
		if (this.sigma) {
			this.sigma.kill();
			this.sigma = null;
		}
	}

	private buildGraph(): InstanceType<typeof Graph> {
		const graph = new Graph({ multi: false, type: "directed" });

		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		const allFiles = this.app.vault.getMarkdownFiles();

		// Add every markdown file as a node
		for (const file of allFiles) {
			if (!graph.hasNode(file.path)) {
				graph.addNode(file.path, {
					label: file.basename,
					x: 0,
					y: 0,
					size: 4,
					color: "#6c8ebf",
				});
			}
		}

		// Add edges from resolvedLinks (source → target)
		for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
			if (!graph.hasNode(sourcePath)) {
				graph.addNode(sourcePath, {
					label: sourcePath,
					x: 0,
					y: 0,
					size: 4,
					color: "#6c8ebf",
				});
			}
			for (const targetPath of Object.keys(targets)) {
				if (!graph.hasNode(targetPath)) {
					graph.addNode(targetPath, {
						label: targetPath,
						x: 0,
						y: 0,
						size: 4,
						color: "#6c8ebf",
					});
				}
				if (!graph.hasEdge(sourcePath, targetPath)) {
					graph.addEdge(sourcePath, targetPath);
				}
			}
		}

		// Scale node size by degree (clamped to a reasonable range)
		graph.forEachNode((node) => {
			const degree = graph.degree(node);
			graph.setNodeAttribute(node, "size", Math.max(4, Math.min(20, 4 + degree * 1.5)));
		});

		return graph;
	}

	/**
	 * Assign random positions in a unit circle for initial layout.
	 * Sigma handles zoom/pan from there; a force-layout is out of scope for Phase 1.
	 */
	private layoutNodes(graph: InstanceType<typeof Graph>): void {
		const count = graph.order;
		let i = 0;
		graph.forEachNode((node) => {
			// Evenly-spaced positions on a circle, with a bit of random noise
			const angle = (2 * Math.PI * i) / Math.max(count, 1);
			const r = 0.8 + Math.random() * 0.4;
			graph.setNodeAttribute(node, "x", r * Math.cos(angle));
			graph.setNodeAttribute(node, "y", r * Math.sin(angle));
			i++;
		});
	}
}
