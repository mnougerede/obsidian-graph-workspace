import { Plugin } from "obsidian";
import { GraphWorkspaceView, VIEW_TYPE } from "./view";

export default class GraphWorkspacePlugin extends Plugin {
	async onload(): Promise<void> {
		this.registerView(VIEW_TYPE, (leaf) => new GraphWorkspaceView(leaf));

		this.addRibbonIcon("git-fork", "Open graph workspace", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open",
			name: "Open graph workspace",
			callback: () => {
				void this.activateView();
			},
		});
	}

	onunload(): void {
		// Leaves are cleaned up automatically by Obsidian when the plugin unloads
	}

	private async activateView(): Promise<void> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0 && existing[0]) {
			workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		workspace.revealLeaf(leaf);
	}
}
