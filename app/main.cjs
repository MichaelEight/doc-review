// Electron wrapper: runs the same local server as `doc-review`, shown in its own window, with a
// native folder picker. No code of its own beyond that.
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

if (!app.requestSingleInstanceLock()) app.quit();

let win;
let origin = "";

async function createWindow() {
  const { startApp } = await import(pathToFileURL(path.join(__dirname, "..", "src", "server.js")).href);
  const { url } = await startApp({ openBrowser: false });
  origin = new URL(url).origin;
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Doc Review",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  // Pages of the app stay in the app; real web links (API key pages, docs) open in the browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(origin)) return { action: "allow" };
    shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, target) => {
    if (!target.startsWith(origin)) {
      e.preventDefault();
      shell.openExternal(target);
    }
  });
  win.loadURL(url);
}

ipcMain.handle("choose-folder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "Choose the folder with your documents" });
  return r.canceled ? null : r.filePaths[0];
});

app.whenReady().then(createWindow);
app.on("second-instance", () => win && (win.isMinimized() && win.restore(), win.focus()));
app.on("window-all-closed", () => app.quit());
