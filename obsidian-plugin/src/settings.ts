import { App, PluginSettingTab, Setting } from "obsidian";
import type CmsSyncPlugin from "./main";
import type { CmsSettings } from "./api";

export const DEFAULT_SETTINGS: CmsSettings = {
  baseUrl: "http://localhost:4021",
  token: "",
  syncFolder: "content/posts",
};

export class CmsSyncSettingTab extends PluginSettingTab {
  plugin: CmsSyncPlugin;

  constructor(app: App, plugin: CmsSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Interactor CMS Sync" });
    containerEl.createEl("p", {
      text: "Create a personal access token at /settings/tokens in the CMS, then paste it below.",
    });

    new Setting(containerEl)
      .setName("CMS base URL")
      .setDesc("e.g. https://cms.interactor.com or http://localhost:4021 for local dev")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:4021")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.replace(/\/$/, "");
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Access token")
      .setDesc("Personal access token (cms_pat_...) from /settings/tokens")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("cms_pat_...")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync folder")
      .setDesc("Vault-relative folder posts are pulled into / pushed from")
      .addText((text) =>
        text
          .setPlaceholder("content/posts")
          .setValue(this.plugin.settings.syncFolder)
          .onChange(async (value) => {
            this.plugin.settings.syncFolder = value.replace(/^\/|\/$/g, "");
            await this.plugin.saveSettings();
          })
      );
  }
}
