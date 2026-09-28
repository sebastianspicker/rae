/** Source-only documentation site with bounded local assets and explicit exclusions. */
import { cpSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitepress";
import { navigation } from "./navigation.js";

export default defineConfig({
  title: "RAE",
  description: "Reliable Agentic Engineering",
  lang: "en-US",
  base: "/rae/",
  outDir: resolve(import.meta.dirname, "../../site"),
  srcExclude: ["agent/**", "archive/**"],
  rewrites: { "INDEX.md": "index.md" },
  head: [["link", { rel: "icon", href: "/rae/assets/brand/rae-mark.svg" }]],
  markdown: { math: true },
  themeConfig: {
    logo: "/assets/brand/rae-mark.svg",
    siteTitle: "RAE",
    sidebar: navigation,
    nav: [
      { text: "Guide", link: "/" },
      { text: "Tutorials", link: "/tutorials/graph-engineering-with-rae" },
      { text: "Reference", link: "/reference/repo-map" },
      { text: "GitHub", link: "https://github.com/sebastianspicker/rae" },
    ],
    search: { provider: "local" },
    outline: [2, 3],
    socialLinks: [{ icon: "github", link: "https://github.com/sebastianspicker/rae" }],
  },
  buildEnd(site) {
    cpSync(resolve(import.meta.dirname, "../assets"), resolve(site.outDir, "assets"), {
      recursive: true,
    });
  },
});
