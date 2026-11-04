const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("docReviewApp", {
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  pathOf: (file) => webUtils.getPathForFile(file),
});
