const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("omniHost", {
  loadConfig: () => ipcRenderer.invoke("host-config:load"),
  saveConfig: (config) => ipcRenderer.invoke("host-config:save", config),
  regenerateCode: () => ipcRenderer.invoke("host-config:regenerate-code"),
  getRuntimeInfo: () => ipcRenderer.invoke("host-runtime:info"),
  requestJson: (request) => ipcRenderer.invoke("host-http:request-json", request)
});
