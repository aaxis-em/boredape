import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = new URL("out/", import.meta.url).pathname;
const PAGE = new URL("../index.html", import.meta.url).href;
const PORT = 9333;
const cpuMode = process.argv.includes("--cpu");
const browser = process.env.CHROME || "chromium-browser";
mkdirSync(OUT, { recursive: true });

const chrome = spawn(browser, [
  "--headless=new", "--no-sandbox", `--remote-debugging-port=${PORT}`,
  "--window-size=1280,800", `--user-data-dir=${OUT}profile`,
  ...(cpuMode ? ["--disable-webgl"] : ["--use-angle=vulkan", "--enable-features=Vulkan", "--ignore-gpu-blocklist"]),
  "about:blank",
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === "page"); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r, { once: true }));

let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type))
    errors.push(`console.${msg.params.type}: ${msg.params.args.map(a => a.value ?? a.description).join(" ")}`);
});
const send = (method, params = {}) => new Promise(res => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async expr => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;
const shot = async name => {
  const { result } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}${name}.png`, Buffer.from(result.data, "base64"));
};
const key = async (k, code) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, text: k });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code });
};
const results = [];
const fieldSum = channel => evaluate(`(() => { let t = 0; for (let i = ${channel}; i < FIELD.length; i += 4) t += FIELD[i]; return t; })()`);
const drag = async (points, button = "left") => {
  const buttons = button === "left" ? 1 : 2;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: points[0][0], y: points[0][1], button, buttons, clickCount: 1 });
  for (const [x, y] of points.slice(1)) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button, buttons });
    await sleep(16);
  }
  const [x, y] = points[points.length - 1];
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1 });
};
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: PAGE });
await sleep(4000);

const info = await evaluate(`({ engine: engine.name, agents: agentCount, W, H, fps: document.getElementById("fps").textContent, hash: location.hash, preset: document.querySelector("#presets .on")?.dataset.name })`);
check("engine selected", info.engine === (cpuMode ? "cpu" : "webgl2"), JSON.stringify(info));
check("default preset marked", info.preset === "marble");
check("fps reported", /\d+ fps/.test(info.fps), info.fps);
await shot(`e2e_${cpuMode ? "cpu" : "gpu"}_default`);

await evaluate(`document.querySelector('#presets button[data-name="mycelium"]').click()`);
await key("h", "KeyH");
check("panel hides on h", await evaluate(`document.getElementById("panel").classList.contains("hidden")`));
await sleep(3000);
await shot(`e2e_${cpuMode ? "cpu" : "gpu"}_mycelium`);
await evaluate(`document.querySelector('#presets button[data-name="veins"]').click()`);
await sleep(1500);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 200, y: 600, button: "left", clickCount: 1 });
for (let t = 0; t <= 60; t++) {
  const x = 200 + t * 14, y = 600 - Math.sin(t / 60 * Math.PI) * 400;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  await sleep(30);
  if (t === 45) await shot(`e2e_${cpuMode ? "cpu" : "gpu"}_drawing`);
}
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1040, y: 600, button: "left", clickCount: 1 });
await sleep(1200);
await shot(`e2e_${cpuMode ? "cpu" : "gpu"}_brush`);

await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 640, y: 400, button: "right", clickCount: 1 });
for (let t = 0; t < 20; t++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640 + t, y: 400, buttons: 2 }); await sleep(30); }
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 660, y: 400, button: "right", clickCount: 1 });
await sleep(300);
await shot(`e2e_${cpuMode ? "cpu" : "gpu"}_erase`);
await key("h", "KeyH");

const before = await evaluate("location.hash");
await key("x", "KeyX");
await sleep(300);
const after = await evaluate("location.hash");
check("randomize rewrites hash", before !== after && after.length > 10, after);
check("toast shown", await evaluate(`document.getElementById("toast").classList.contains("show")`));
const randomized = await evaluate("JSON.stringify({p: state.params, pal: state.palette, seed: state.seed})");

await key(" ", "Space");
const paused = await evaluate("state.paused");
await key(" ", "Space");
check("space toggles pause", paused === true && (await evaluate("state.paused")) === false);

await send("Page.navigate", { url: "about:blank" });
await sleep(300);
await send("Page.navigate", { url: PAGE + after });
await sleep(2500);
const restored = await evaluate("JSON.stringify({p: state.params, pal: state.palette, seed: state.seed})");
check("hash round-trips state", restored === randomized, restored);
await shot(`e2e_${cpuMode ? "cpu" : "gpu"}_restored`);

await evaluate(`(() => { const s = document.querySelectorAll("#sliders input")[0]; s.value = 2; s.dispatchEvent(new Event("input")); })()`);
check("species slider applies", (await evaluate("state.params.species")) === 2);

await evaluate(`location.hash = "#ink/ring/1,45,9,45,1,0.75,0.5,0,0.25"`);
await sleep(300);
check("hashchange in open tab applies", (await evaluate("state.palette + '/' + state.seed + '/' + state.params.decay")) === "ink/ring/0.75");

await send("Page.navigate", { url: "about:blank" });
await sleep(300);
await send("Page.navigate", { url: PAGE + "#garbage/stuff/1,2" });
await sleep(1500);
check("bad hash falls back to default", (await evaluate("state.palette + '/' + document.querySelector('#presets .on')?.dataset.name")) === "ember/marble");

const tag = cpuMode ? "cpu" : "gpu";
await send("Page.navigate", { url: "about:blank" });
await sleep(300);
await send("Page.navigate", { url: PAGE + "#abyss/scatter/1,45,25,45,1.5,0.85,0.5,0,0.3" });
await sleep(1500);
await key("h", "KeyH");
await key(" ", "Space");
const foods = [[260, 180], [620, 120], [1000, 200], [180, 480], [560, 400], [900, 520], [1120, 380]];
for (const [x, y] of foods) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(60);
}
await sleep(300);
check("clicks place food while paused", (await fieldSum(0)) > 100);
await shot(`e2e_${tag}_food_paused`);
await key(" ", "Space");
await sleep(9000);
await shot(`e2e_${tag}_food_network`);
await key("c", "KeyC");
await sleep(2500);
await shot(`e2e_${tag}_food_cleared`);

await evaluate(`document.querySelector('#presets button[data-name="network"]').click()`);
check("network preset applies petri palette", (await evaluate("state.palette")) === "petri");
await sleep(12000);
await shot(`e2e_${tag}_network_preset`);

await key("c", "KeyC");
await sleep(200);
check("c clears the field", (await fieldSum(0)) === 0 && (await fieldSum(1)) === 0);
await key("2", "Digit2");
check("2 selects wall brush", (await evaluate("state.brush")) === "wall");
await drag(Array.from({ length: 30 }, (_, i) => [300 + i * 20, 330]));
await sleep(100);
const walls = await fieldSum(1);
check("wall brush paints walls", walls > 500, walls.toFixed(0));
await drag(Array.from({ length: 12 }, (_, i) => [520 + i * 10, 330]), "right");
await sleep(100);
const wallsAfter = await fieldSum(1);
check("right-drag erases walls", wallsAfter < walls * 0.85, `${walls.toFixed(0)} -> ${wallsAfter.toFixed(0)}`);
await key("1", "Digit1");

await send("Page.navigate", { url: "about:blank" });
await sleep(300);
await send("Page.navigate", { url: PAGE + "#petri/scatter/1,45,12,45,1,0.85,0.5,0,0.1/maze-1234" });
await sleep(1500);
const mazeA = await fieldSum(1);
await send("Page.navigate", { url: "about:blank" });
await sleep(300);
await send("Page.navigate", { url: PAGE + "#petri/scatter/1,45,12,45,1,0.85,0.5,0,0.1/maze-1234" });
await sleep(1500);
check("maze is deterministic from its seed", mazeA > 0 && (await fieldSum(1)) === mazeA, mazeA.toFixed(0));
await key("h", "KeyH");
await sleep(9000);
const tero = await evaluate(`(() => {
  const { adj, source, sink, edges } = solver;
  const dist = new Array(adj.length).fill(-1); dist[source] = 0;
  const q = [source];
  while (q.length) { const i = q.shift(); for (const e of adj[i]) { const j = e.a === i ? e.b : e.a; if (dist[j] < 0) { dist[j] = dist[i] + 1; q.push(j); } } }
  return { strong: edges.filter(e => e.D > 0.5).length, shortest: dist[sink] };
})()`);
check("Tero solver keeps exactly the shortest path", tero.strong === tero.shortest, JSON.stringify(tero));
await shot(`e2e_${tag}_maze`);
await key("h", "KeyH");

await evaluate(`(() => {
  document.getElementById("write-text").value = "slime";
  document.getElementById("write").requestSubmit();
})()`);
await sleep(200);
check("grow a word sets text scene", (await evaluate("location.hash")).endsWith("/text-slime"));
check("text marks fertile ground", (await fieldSum(2)) < (await evaluate("W * H")) * 0.97);
await key("h", "KeyH");
await sleep(8000);
await shot(`e2e_${tag}_text`);
await key("h", "KeyH");

await evaluate(`HTMLAnchorElement.prototype.click = function () { window.__download = this.download; }`);
await key("v", "KeyV");
check("v starts recording", await evaluate("!!recorder && recorder.state === 'recording'"));
await sleep(1500);
await key("v", "KeyV");
await sleep(800);
const dl = await evaluate("window.__download || ''");
check("recording downloads a video", /^physarum-\d+\.(webm|mp4)$/.test(dl), dl);

await sleep(500);
check("fps after warmup", true, await evaluate(`document.getElementById("fps").textContent + " · " + agentCount + " agents"`));
check("no console errors", errors.length === 0, errors.join(" | "));

console.log(results.join("\n"));
ws.close();
chrome.kill();
process.exit(results.some(r => r.startsWith("FAIL")) ? 1 : 0);
