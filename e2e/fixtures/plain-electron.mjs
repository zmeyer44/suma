import { app, BrowserWindow } from "electron";

const target = process.env.SUMA_LIVE_GOOGLE_URL;
if (target === undefined) throw new Error("SUMA_LIVE_GOOGLE_URL is required");

void app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true },
  });
  void window.loadURL(target);
});

app.on("window-all-closed", () => app.quit());
