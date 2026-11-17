/*
 * build_projects.js (lives in projects/)
 * --------------------------------------
 * 1. Validates every entry in projects/projects_items.yml. Nothing is written if a check fails.
 * 2. Renders one Quarto page per entry into projects/<slug>.qmd using projects_template.ejs.
 * 3. Rewrites the generated "projects-sidebar" block in ../_quarto.yml, grouped by category.
 *
 * Setup (once):              npm install ejs js-yaml
 * Run from the project root: node projects/build_projects.js
 * Then:                      quarto preview   (or quarto render)
 */
const fs = require("fs");
const path = require("path");
const ejs = require("ejs");
const yaml = require("js-yaml");

const PROJECTS_DIR = __dirname;
const ROOT = path.join(PROJECTS_DIR, "..");
const ITEMS_FILE = path.join(PROJECTS_DIR, "projects_items.yml");
const TEMPLATE_FILE = path.join(PROJECTS_DIR, "projects_template.ejs");
const QUARTO_FILE = path.join(ROOT, "_quarto.yml");
const SIDEBAR_ID = "projects-sidebar";
const BEGIN = "# BEGIN generated: projects-sidebar";
const END = "# END generated: projects-sidebar";
const BRAND = "dmitry rastorguev";
const REQUIRED = [
  "slug", "nav_title", "category", "name", "meta_description", "keywords", "status",
  "project_statement", "requirements", "approach", "implementation", "team",
  "roadmap", "measures_of_success",
];

// ---- 1. Validation -------------------------------------------------------
function validate(items) {
  const errors = [];
  const slugs = new Set();
  const keywordOwner = new Map();
  for (const item of items) {
    const where = item.slug || "(entry without slug)";
    for (const field of REQUIRED) {
      const v = item[field];
      if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
        errors.push(`${where}: missing "${field}"`);
      }
    }
    if (slugs.has(item.slug)) errors.push(`${where}: duplicate slug`);
    slugs.add(item.slug);
    if (item.status && Object.keys(item.status).some((k) => k !== "sector")) {
      errors.push(`${where}: status may only contain "sector"`);
    }
    if (item.meta_description && item.meta_description.length > 160) {
      errors.push(`${where}: meta_description is ${item.meta_description.length} characters (max 160)`);
    }
    if (Array.isArray(item.keywords)) {
      if (item.keywords.length < 15 || item.keywords.length > 16) {
        errors.push(`${where}: ${item.keywords.length} keywords (need 15 to 16)`);
      }
      for (const kw of item.keywords) {
        const key = String(kw).trim().toLowerCase();
        if (key === BRAND) continue; // the brand name is the one allowed repeat
        if (keywordOwner.has(key) && keywordOwner.get(key) !== item.slug) {
          errors.push(`${where}: keyword "${kw}" already used on ${keywordOwner.get(key)}`);
        }
        keywordOwner.set(key, item.slug);
      }
    }
  }
  return errors;
}

const items = yaml.load(fs.readFileSync(ITEMS_FILE, "utf8"));
const errors = validate(items);
if (errors.length) {
  console.error("Build stopped. Fix these entries in projects_items.yml:");
  errors.forEach((e) => console.error("  - " + e));
  process.exit(1);
}

// ---- 2. Pages ------------------------------------------------------------
const render = ejs.compile(fs.readFileSync(TEMPLATE_FILE, "utf8"));
const cell = (s) => String(s).replace(/\|/g, "/");   // keep table cells intact
for (const item of items) {
  fs.writeFileSync(path.join(PROJECTS_DIR, `${item.slug}.qmd`), render({ item, cell }));
}

// ---- 3. Sidebar ----------------------------------------------------------
const sections = new Map();
for (const item of items) {
  if (!sections.has(item.category)) sections.set(item.category, []);
  sections.get(item.category).push(item);
}
const lines = [
  `    ${BEGIN}`,
  `    - id: ${SIDEBAR_ID}`,
  `      title: "Projects"`,
  `      style: docked`,
  `      background: light`,
  `      contents:`,
  `        - text: "Overview"`,
  `          file: projects.qmd`,
];
for (const [category, group] of sections) {
  lines.push(`        - section: ${JSON.stringify(category)}`);
  lines.push(`          contents:`);
  for (const item of group) {
    lines.push(`            - text: ${JSON.stringify(item.nav_title)}`);
    lines.push(`              file: projects/${item.slug}.qmd`);
  }
}
lines.push(`    ${END}`);

const quarto = fs.readFileSync(QUARTO_FILE, "utf8");
const start = quarto.indexOf(`    ${BEGIN}`);
const endMarker = quarto.indexOf(`    ${END}`);
if (start === -1 || endMarker === -1) throw new Error("Sidebar markers not found in _quarto.yml");
const afterEnd = quarto.indexOf("\n", endMarker) + 1;
fs.writeFileSync(QUARTO_FILE, quarto.slice(0, start) + lines.join("\n") + "\n" + quarto.slice(afterEnd));

console.log(`Validated ${items.length} entries. Generated ${items.length} pages and updated the projects sidebar.`);
