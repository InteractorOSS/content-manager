import { Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import JSZip from "jszip";
import { CmsSyncSettingTab, DEFAULT_SETTINGS } from "./settings";
import { CmsApiError, exportAllRaw, importPost, type CmsSettings } from "./api";
import { serializePostFile } from "./frontmatter";

/**
 * Interactor CMS Sync — Phase 3 rung 2 of FILE-BASED-CONTENT-PLAN.md's
 * desktop sync ladder. Same engine as scripts/cms-sync.ts (the CLI), same
 * API, same conflict semantics — just packaged for the audience the plan
 * doc calls out as the best adoption fit: people already living in Obsidian.
 */
export default class CmsSyncPlugin extends Plugin {
  settings: CmsSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CmsSyncSettingTab(this.app, this));

    this.addRibbonIcon("git-pull-request-arrow", "CMS: Pull posts", () => {
      void this.pull();
    });

    this.addCommand({
      id: "cms-pull",
      name: "Pull posts from CMS",
      callback: () => void this.pull(),
    });

    this.addCommand({
      id: "cms-push-current",
      name: "Push current file to CMS",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.pushFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "cms-push-all",
      name: "Push all changed files in sync folder to CMS",
      callback: () => void this.pushAll(),
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private requireConfigured(): boolean {
    if (!this.settings.baseUrl || !this.settings.token) {
      new Notice("Set the CMS base URL and access token in plugin settings first.");
      return false;
    }
    return true;
  }

  async pull() {
    if (!this.requireConfigured()) return;
    new Notice("Pulling posts from CMS…");
    try {
      const archive = await exportAllRaw(this.settings);
      const zip = await JSZip.loadAsync(archive);
      const folder = normalizePath(this.settings.syncFolder);
      if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
        await this.app.vault.createFolder(folder);
      }

      let count = 0;
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir || !path.endsWith(".md")) continue;
        const content = await entry.async("string");
        const dest = normalizePath(`${folder}/${path.split("/").pop()}`);
        const existing = this.app.vault.getAbstractFileByPath(dest);
        if (existing instanceof TFile) {
          await this.app.vault.modify(existing, content);
        } else {
          await this.app.vault.create(dest, content);
        }
        count++;
      }
      new Notice(`Pulled ${count} post(s) into ${folder}`);
    } catch (err) {
      new Notice(`CMS pull failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async pushFile(file: TFile, force = false) {
    if (!this.requireConfigured()) return;
    try {
      const raw = await this.app.vault.read(file);
      const result = await importPost(this.settings, raw, file.name, force);
      await this.app.vault.modify(file, serializePostFile(result.data));
      new Notice(
        `${result.created ? "Created" : "Updated"}: ${file.name}` +
          (result.warning ? ` — ${result.warning}` : "")
      );
    } catch (err) {
      if (err instanceof CmsApiError && err.status === 409) {
        new Notice(
          `Conflict on ${file.name}: someone else changed this post since it was last synced. ` +
            `Pull to see their edit, or run "Push current file" again after pulling to force-overwrite.`,
          10000
        );
        return;
      }
      new Notice(`Push failed for ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async pushAll() {
    if (!this.requireConfigured()) return;
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.syncFolder));
    if (!(folder instanceof TFolder)) {
      new Notice(`Sync folder "${this.settings.syncFolder}" not found — pull first.`);
      return;
    }
    const files = folder.children.filter(
      (f): f is TFile => f instanceof TFile && f.extension === "md"
    );
    new Notice(`Pushing ${files.length} file(s)…`);
    for (const file of files) {
      await this.pushFile(file);
    }
  }
}
