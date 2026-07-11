import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireValidPort(rawValue, value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    console.error(`Invalid PORT '${rawValue}'. Set PORT to an integer between 1 and 65535.`);
    process.exit(1);
  }
  return value;
}

function requireValidInterval(rawValue, value) {
  if (!Number.isFinite(value)) {
    console.error(`Invalid FRAME_INTERVAL_MS '${rawValue}'. Set it to a number of milliseconds.`);
    process.exit(1);
  }
  return value;
}

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = requireValidPort(process.env.PORT, Number(process.env.PORT ?? 4173));
const ADB_SERIAL = process.env.ADB_SERIAL?.trim() || null;
const FEELD_PACKAGE = process.env.FEELD_PACKAGE?.trim() || "co.feeld";
const FRAME_INTERVAL_MS = Math.max(
  250,
  requireValidInterval(process.env.FRAME_INTERVAL_MS, Number(process.env.FRAME_INTERVAL_MS ?? 450))
);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: "1h"
}));

let latestFrame = null;
let frameVersion = 0;
let sourceWidth = 0;
let sourceHeight = 0;
let lastFrameAt = null;
let lastError = null;
let capturing = false;
let lastDeviceCheckAt = 0;
const DEVICE_RECHECK_MS = 3000;
const sseClients = new Set();

function adbArgs(args) {
  return ADB_SERIAL ? ["-s", ADB_SERIAL, ...args] : args;
}

function errorMessage(error) {
  if (error?.code === "ENOENT") {
    return "adb was not found on PATH. Install Android Platform Tools and confirm `adb` runs in a terminal.";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error?.killed || /timed out/i.test(message)) {
    return "The adb command timed out. Check the USB connection and that the device is unlocked.";
  }
  return message;
}

// Serializes adb input commands so rapid clicks can't spawn overlapping
// `adb shell` processes that race or arrive at the device out of order.
let inputQueue = Promise.resolve();
function queueInput(task) {
  const run = inputQueue.then(task, task);
  inputQueue = run.then(() => {}, () => {});
  return run;
}

async function adbText(args, timeout = 8000) {
  const { stdout } = await execFileAsync("adb", adbArgs(args), {
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout.trim();
}

async function adbBuffer(args, timeout = 10000) {
  const { stdout } = await execFileAsync("adb", adbArgs(args), {
    encoding: "buffer",
    timeout,
    maxBuffer: 32 * 1024 * 1024
  });
  return stdout;
}

async function assertDevice() {
  const output = await adbText(["devices"]);
  const devices = output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.endsWith("\tdevice"));

  if (ADB_SERIAL) {
    const found = devices.some((line) => line.startsWith(`${ADB_SERIAL}\t`));
    if (!found) throw new Error(`ADB device '${ADB_SERIAL}' is not connected or authorized.`);
    return;
  }

  if (devices.length === 0) throw new Error("No authorized Android device or emulator is connected.");
  if (devices.length > 1) {
    throw new Error("More than one Android device is connected. Set ADB_SERIAL before starting the server.");
  }
}

function statusPayload() {
  return {
    ok: Boolean(latestFrame) && !lastError,
    serial: ADB_SERIAL,
    package: FEELD_PACKAGE,
    sourceWidth,
    sourceHeight,
    frameVersion,
    lastFrameAt,
    error: lastError
  };
}

function broadcastStatus() {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(statusPayload())}\n\n`;
  for (const client of sseClients) client.write(payload);
}

async function captureFrame() {
  if (capturing) return;

  const now = Date.now();
  const dueForRecheck = now - lastDeviceCheckAt > DEVICE_RECHECK_MS;

  // While a known error persists, only retry at the recheck cadence instead
  // of spawning an adb process on every single capture tick.
  if (lastError && !dueForRecheck) return;

  capturing = true;

  try {
    if (dueForRecheck) {
      await assertDevice();
      lastDeviceCheckAt = now;
    }

    const png = await adbBuffer(["exec-out", "screencap", "-p"]);
    const metadata = await sharp(png).metadata();

    if (!metadata.width || !metadata.height) {
      throw new Error("Android returned an unreadable screenshot.");
    }

    sourceWidth = metadata.width;
    sourceHeight = metadata.height;
    latestFrame = await sharp(png)
      .resize({ width: 900, withoutEnlargement: true })
      .jpeg({ quality: 76, mozjpeg: true })
      .toBuffer();

    frameVersion += 1;
    lastFrameAt = new Date().toISOString();
    lastError = null;
  } catch (error) {
    lastError = errorMessage(error);
  } finally {
    capturing = false;
    broadcastStatus();
  }
}

const captureTimer = setInterval(captureFrame, FRAME_INTERVAL_MS);
captureTimer.unref();
await captureFrame();

if (lastError) {
  console.warn(`Feeld Browser Bridge: initial screen capture failed: ${lastError}`);
}

app.get("/api/status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(statusPayload());
});

app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive"
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(statusPayload())}\n\n`);

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

app.get("/api/frame.jpg", (_req, res) => {
  if (!latestFrame) {
    return res.status(503).json({ error: lastError ?? "No frame is available yet." });
  }

  res.set({
    "Content-Type": "image/jpeg",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0"
  });
  return res.send(latestFrame);
});

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number.`);
  return number;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

app.post("/api/tap", async (req, res) => {
  try {
    if (!sourceWidth || !sourceHeight) throw new Error("Screen dimensions are not available yet.");
    const x = Math.round(clamp(finiteNumber(req.body.x, "x"), 0, sourceWidth - 1));
    const y = Math.round(clamp(finiteNumber(req.body.y, "y"), 0, sourceHeight - 1));
    await queueInput(() => adbText(["shell", "input", "tap", String(x), String(y)]));
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.post("/api/swipe", async (req, res) => {
  try {
    if (!sourceWidth || !sourceHeight) throw new Error("Screen dimensions are not available yet.");
    const x1 = Math.round(clamp(finiteNumber(req.body.x1, "x1"), 0, sourceWidth - 1));
    const y1 = Math.round(clamp(finiteNumber(req.body.y1, "y1"), 0, sourceHeight - 1));
    const x2 = Math.round(clamp(finiteNumber(req.body.x2, "x2"), 0, sourceWidth - 1));
    const y2 = Math.round(clamp(finiteNumber(req.body.y2, "y2"), 0, sourceHeight - 1));
    const duration = Math.round(clamp(finiteNumber(req.body.duration ?? 280, "duration"), 80, 1500));

    await queueInput(() => adbText([
      "shell", "input", "swipe",
      String(x1), String(y1), String(x2), String(y2), String(duration)
    ]));
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

const ALLOWED_KEYS = new Set([
  "BACK", "HOME", "APP_SWITCH", "ENTER", "DEL", "TAB",
  "POWER", "VOLUME_UP", "VOLUME_DOWN"
]);

app.post("/api/key", async (req, res) => {
  try {
    const key = String(req.body.key ?? "").toUpperCase();
    if (!ALLOWED_KEYS.has(key)) throw new Error("Unsupported key.");
    await queueInput(() => adbText(["shell", "input", "keyevent", `KEYCODE_${key}`]));
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

function encodeAndroidInputText(value) {
  // Android's `input text` uses %s for spaces. Backslashes prevent the
  // remote shell from interpreting common punctuation as shell syntax.
  return value
    .replace(/%/g, "%25")
    .replace(/ /g, "%s")
    .replace(/([&<>|;*~'"`$()\\])/g, "\\$1");
}

app.post("/api/type", async (req, res) => {
  try {
    const text = String(req.body.text ?? "");
    if (!text) throw new Error("Text is empty.");
    if (text.length > 500) throw new Error("Text must be 500 characters or fewer.");
    if (/[^\x20-\x7E]/.test(text)) {
      throw new Error("This typing bridge currently supports basic ASCII text only.");
    }

    await queueInput(() => adbText(["shell", "input", "text", encodeAndroidInputText(text)]));
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.post("/api/open-feeld", async (_req, res) => {
  try {
    await queueInput(() => adbText([
      "shell", "monkey", "-p", FEELD_PACKAGE,
      "-c", "android.intent.category.LAUNCHER", "1"
    ]));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/wake", async (_req, res) => {
  try {
    await queueInput(() => adbText(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Feeld Browser Bridge: http://${HOST}:${PORT}`);
  console.log(`ADB target: ${ADB_SERIAL ?? "the only connected device"}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Set PORT to a different value.`);
    process.exit(1);
  }
  throw error;
});

function shutdown(exitCode = 0) {
  clearInterval(captureTimer);
  for (const client of sseClients) client.end();
  server.close(() => process.exit(exitCode));
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

process.on("uncaughtException", (error) => {
  console.error(`Uncaught exception: ${errorMessage(error)}`);
  shutdown(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`Unhandled promise rejection: ${errorMessage(reason)}`);
  shutdown(1);
});
