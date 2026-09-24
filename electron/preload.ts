/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Preload bridge.
 *
 * Runs sandboxed with context isolation on, so it has no Node access beyond
 * Electron's own IPC. The exposed surface is intentionally tiny and read-only:
 * the renderer can ask where the server is listening, but it cannot ask the
 * main process to read files, spawn anything, or navigate.
 */

import { contextBridge, ipcRenderer } from "electron";

export interface ServerInfo {
  httpPort: number;
  httpsPort: number;
  httpUrl: string;
  httpsUrl: string;
}

export interface SendFilesDesktopAPI {
  /** True whenever the UI is running inside the desktop shell. */
  readonly isDesktop: true;
  /** Where the bundled server is listening. */
  getServerInfo: () => Promise<ServerInfo | null>;
  /** Shareable LAN URL for other devices, or null if offline. */
  getLanUrl: () => Promise<string | null>;
  getVersion: () => Promise<string>;
}

const api: SendFilesDesktopAPI = {
  isDesktop: true,
  getServerInfo: () => ipcRenderer.invoke("app:get-server-info"),
  getLanUrl: () => ipcRenderer.invoke("app:get-lan-url"),
  getVersion: () => ipcRenderer.invoke("app:get-version")
};

contextBridge.exposeInMainWorld("sendfilesDesktop", api);
