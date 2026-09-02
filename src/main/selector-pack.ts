import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface SelectorPack {
  version: number;
  updatedAt: string;
  baseUrl: string;
  loginUrl: string;
  authenticatedUrlPatterns: string[];
  humanCheckpointTexts: string[];
  projects: {
    homePath: string;
    selectorTrigger: string[];
    selectorPanel: string[];
    workspaceItems: string[];
    projectItems: string[];
    newProjectButtons: string[];
    newProjectDialog: string[];
    projectNameInputs: string[];
    customerInputs: string[];
    creationTypeInputs: string[];
  };
  generation: {
    prompt: string[];
    imageInput: string[];
    composer: string[];
    materialList: string[];
    modelToggle: string[];
    modelDialog: string[];
    parameterToggle: string[];
    parameterPopover: string[];
    audioToggle: string[];
    advancedToggle: string[];
    advancedPopover: string[];
    portraitEntry: string[];
    portraitDialog: string[];
    portraitCards: string[];
    portraitCheckbox: string[];
    submitButtons: string[];
    userMessages: string[];
    agentMessages: string[];
    videoResults: string[];
    downloadButtons: string[];
    taskIdAttributes: string[];
  };
  portrait: {
    entryTexts: string[];
    pagePath: string;
    createTexts: string[];
    localUploadTexts: string[];
    dialog: string[];
    uploadInput: string[];
    submitButtons: string[];
  };
}

export function selectorPackPath(): string {
  return app.isPackaged
    ? path.join(app.getAppPath(), "config", "xinying-selectors.json")
    : path.join(process.cwd(), "config", "xinying-selectors.json");
}

export function loadSelectorPack(): SelectorPack {
  return JSON.parse(fs.readFileSync(selectorPackPath(), "utf8")) as SelectorPack;
}
