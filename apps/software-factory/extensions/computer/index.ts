/**
 * Computer use for Pi: a virtual desktop (Xvfb) it sees in screenshots and drives with the mouse and keyboard,
 * like a person at the screen. Codex does it the same way, as one tool whose calls each carry a title.
 * Each call does one action, then returns a screenshot of the result. While ui-video is recording the desktop,
 * the title is also that step's caption.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const DISPLAY = process.env.COMPUTER_DISPLAY ?? ":99";
const [WIDTH, HEIGHT] = (process.env.COMPUTER_SIZE ?? "1280x800").split("x").map(Number) as [number, number];
const env = () => ({ ...process.env, DISPLAY });
/** Where ui-video keeps its take: steps go there while it records. */
const VIDEO = process.env.UI_VIDEO_DIR ?? "/tmp/ui-video";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the desktop's X server is up: its lock file names a live process. */
function up() {
  try {
    process.kill(Number(readFileSync(`/tmp/.X${DISPLAY.slice(1)}-lock`, "utf8").trim()), 0);
    return existsSync(`/tmp/.X11-unix/X${DISPLAY.slice(1)}`);
  } catch {
    return false;
  }
}

function detach(cmd: string, args: string[]) {
  spawn(cmd, args, { env: env(), detached: true, stdio: "ignore" }).unref();
}

/** Starts the desktop the first time it's needed, and again if it died. */
async function desktop() {
  if (up()) return;
  detach("Xvfb", [DISPLAY, "-screen", "0", `${WIDTH}x${HEIGHT}x24`, "-nolisten", "tcp"]);
  const socket = `/tmp/.X11-unix/X${DISPLAY.slice(1)}`;
  for (let i = 0; i < 50 && !existsSync(socket); i++) await sleep(100);
  if (!existsSync(socket)) throw new Error("the virtual desktop (Xvfb) didn't start: is it installed?");
}

/** The Chrome agent-browser installed: Chrome for Testing, in Pi's home. */
function chrome() {
  const dir = join(homedir(), ".agent-browser", "browsers");
  const found = existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith("chrome-")).sort().pop() : undefined;
  if (!found) throw new Error("no Chrome: run `agent-browser install`");
  return join(dir, found, "chrome");
}

async function screenshot() {
  const { stdout } = await run(
    "ffmpeg",
    ["-nostdin", "-loglevel", "error", "-f", "x11grab", "-video_size", `${WIDTH}x${HEIGHT}`, "-i", DISPLAY, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
    { env: env(), encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.toString("base64");
}

const input = (...args: (string | number)[]) => run("python3", [join(HERE, "xinput.py"), ...args.map(String)], { env: env() });

const ACTIONS = ["screenshot", "open", "click", "double_click", "right_click", "move", "drag", "type", "key", "scroll", "wait"] as const;

function need<T>(value: T | undefined, what: string, action: string): T {
  if (value === undefined || value === "") throw new Error(`${action} needs ${what}`);
  return value;
}

export const computer = defineTool({
  name: "computer",
  label: "Computer",
  // One screen, one mouse: actions happen in the order they're asked for, each seeing the last one's result.
  executionMode: "sequential",
  description: `Use a virtual ${WIDTH}x${HEIGHT} desktop like a person: see it, click, type. Each call does one action and returns a screenshot of the screen afterwards, so look at it before the next action. Coordinates are pixels from the top-left of that screenshot.
Actions: screenshot; open (url: opens it in Chrome, or command: starts a program on the desktop); click, double_click, right_click, move (x, y); drag (x, y to to_x, to_y); type (text, into whatever has focus: click the field first); key (keys, like "Return", "ctrl+l", "shift+Tab", several separated by spaces); scroll (x, y, amount: wheel clicks, positive down); wait (seconds).
While ui-video is recording, each call's title is the video's caption from then on.`,
  parameters: Type.Object({
    title: Type.String({
      description: "What you're doing, as one short first-person sentence (\"Opening the login page\"). It's the video caption while recording.",
    }),
    action: StringEnum(ACTIONS),
    x: Type.Optional(Type.Number()),
    y: Type.Optional(Type.Number()),
    to_x: Type.Optional(Type.Number()),
    to_y: Type.Optional(Type.Number()),
    text: Type.Optional(Type.String()),
    keys: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    command: Type.Optional(Type.String({ description: "For open: a shell command to start on the desktop." })),
    amount: Type.Optional(Type.Number()),
    seconds: Type.Optional(Type.Number()),
  }),

  async execute(_id, p) {
    await desktop();
    if (existsSync(join(VIDEO, "recording"))) {
      await run(join(HERE, "..", "..", "skills", "ui-video", "scripts", "ui-video"), ["step", p.title]).catch(() => {});
    }
    const xy = () => [Math.round(need(p.x, "x", p.action)), Math.round(need(p.y, "y", p.action))] as const;
    switch (p.action) {
      case "screenshot":
        break;
      case "open":
        if (p.url) {
          // One Chrome per desktop: opening again adds a tab to it.
          detach(chrome(), [
            "--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen", "--disable-infobars",
            `--user-data-dir=${join(homedir(), ".computer-chrome")}`, "--window-position=0,0", `--window-size=${WIDTH},${HEIGHT}`,
            p.url,
          ]);
        } else detach("bash", ["-c", need(p.command, "url or command", "open")]);
        await sleep(2500);
        break;
      case "click":
      case "double_click":
      case "right_click":
        await input("click", ...xy(), p.action === "right_click" ? 3 : 1, p.action === "double_click" ? 2 : 1);
        break;
      case "move":
        await input("move", ...xy());
        break;
      case "drag":
        await input("drag", ...xy(), Math.round(need(p.to_x, "to_x", "drag")), Math.round(need(p.to_y, "to_y", "drag")));
        break;
      case "type":
        await input("type", need(p.text, "text", "type"));
        break;
      case "key":
        await input("key", ...need(p.keys, "keys", "key").split(/\s+/).filter(Boolean));
        break;
      case "scroll":
        await input("scroll", ...xy(), Math.round(p.amount ?? 3));
        break;
      case "wait":
        await sleep(Math.min(30, p.seconds ?? 1) * 1000);
        break;
    }
    // Let the page react before looking at it.
    if (p.action !== "screenshot" && p.action !== "wait") await sleep(600);
    return {
      content: [
        { type: "text" as const, text: `${p.action} done. The screen now:` },
        { type: "image" as const, data: await screenshot(), mimeType: "image/png" },
      ],
      details: { action: p.action, title: p.title },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(computer);
}
