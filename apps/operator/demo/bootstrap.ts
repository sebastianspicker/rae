/** Activates the in-browser mock transport before the unchanged operator app loads. */
import { setTransport } from "../static/js/api.js";
import { createDemoTransport } from "./transport.js";

document.documentElement.dataset.demo = "true";
document.getElementById("demo-disclaimer")!.hidden = false;
setTransport(createDemoTransport());
await import("../static/app.js");
