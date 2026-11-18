/*
 * build_projects.js (lives in projects_utils/, beside projects/)
 * ---------------------------------------------------------------
 * 1. Validates every entry in projects_utils/projects_items.yml. Nothing is written if a check fails.
 * 2. Renders one Quarto page per entry to projects/<slug>.qmd using projects_template.ejs.
 *    Quarto builds each page to /projects/<slug>.html.
 * 3. Rewrites the generated "projects-sidebar" block in ../_quarto.yml. The sidebar follows the
 *    order of projects_items.yml, so the two always match.
 * 4. Rewrites the generated "projects-nav" block in ../projects.qmd, in the same order.
 *
 * Setup (once):              npm install ejs js-yaml
 * Run from the project root: node projects_utils/build_projects.js
 * Then:                      quarto preview   (or quarto render)
 */
const fs = require("fs");
const path = require("path");
const ejs = require("ejs");
const yaml = require("js-yaml");

const UTILS_DIR = __dirname;
const ROOT = path.join(UTILS_DIR, "..");
const PAGES_DIR = path.join(ROOT, "projects");
const LEGACY_DIR = path.join(PAGES_DIR, "qmds");
const ITEMS_FILE = path.join(UTILS_DIR, "projects_items.yml");
const TEMPLATE_FILE = path.join(UTILS_DIR, "projects_template.ejs");
const QUARTO_FILE = path.join(ROOT, "_quarto.yml");
const SIDEBAR_ID = "projects-sidebar";
const BEGIN = "# BEGIN generated: projects-sidebar";
const END = "# END generated: projects-sidebar";
// Phrase in the template's header comment. Files containing it were written by this build.
const GENERATED_MARK = "Edit the data or template, not this file.";
const BRAND = "dmitry rastorguev";
const REQUIRED = [
  "slug", "nav_title", "category", "name", "meta_description", "keywords",
  "project_statement", "requirements", "approach", "implementation",
  "roadmap", "measures_of_success",
];
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Quarto preview watches the project's files, and rewriting a file (even with identical
// content) triggers another render. Only write when the content has changed.
function writeIfChanged(file, content) {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return false;
  fs.writeFileSync(file, content);
  return true;
}

// ---- 1. Validation -------------------------------------------------------
function validate(items) {
  const errors = [];
  const slugs = new Set();
  const navTitles = new Set();
  const keywordOwner = new Map();

  for (const item of items) {
    const where = item.slug || "(entry without slug)";

    for (const field of REQUIRED) {
      const v = item[field];
      if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
        errors.push(`${where}: missing "${field}"`);
      }
    }

    if (item.slug && !SLUG_PATTERN.test(item.slug)) {
      errors.push(`${where}: slug must use lowercase letters, digits and single hyphens`);
    }
    if (slugs.has(item.slug)) errors.push(`${where}: duplicate slug`);
    slugs.add(item.slug);

    if (navTitles.has(item.nav_title)) errors.push(`${where}: nav_title is used by another entry`);
    navTitles.add(item.nav_title);

    if (item.meta_description && item.meta_description.length > 160) {
      errors.push(`${where}: meta_description is ${item.meta_description.length} characters (max 160)`);
    }

    if (Array.isArray(item.keywords)) {
      if (item.keywords.length < 15 || item.keywords.length > 16) {
        errors.push(`${where}: ${item.keywords.length} keywords (need 15 to 16)`);
      }
      const own = new Set();
      for (const kw of item.keywords) {
        const key = String(kw).trim().toLowerCase();
        if (own.has(key)) errors.push(`${where}: keyword "${kw}" is listed twice`);
        own.add(key);
        if (key === BRAND) continue;
        if (keywordOwner.has(key) && keywordOwner.get(key) !== item.slug) {
          errors.push(`${where}: keyword "${kw}" already used on ${keywordOwner.get(key)}`);
        }
        keywordOwner.set(key, item.slug);
      }
    }

    // Shape checks for the parts the template reads, so a bad entry fails here, not in ejs.
    const approach = item.approach || {};
    if (!approach.intro || !approach.trade_off || !Array.isArray(approach.parts) || approach.parts.length === 0) {
      errors.push(`${where}: approach needs intro, parts (title and text) and trade_off`);
    } else if (approach.parts.some((p) => !p.title || !p.text)) {
      errors.push(`${where}: every approach part needs a title and text`);
    }
    if (!Array.isArray(item.implementation) || item.implementation.some((s) => !s.title || !s.text)) {
      errors.push(`${where}: every implementation step needs a title and text`);
    }
    const phases = (item.roadmap && item.roadmap.phases) || [];
    if (!Array.isArray(phases) || phases.length === 0 || phases.some((p) => !p.phase || !p.timing || !p.deliverable)) {
      errors.push(`${where}: every roadmap phase needs phase, timing and deliverable`);
    }
  }

  // The sidebar groups entries by category in the order they first appear. A category that
  // reappears later would move entries and break the match with this file's order.
  const seen = new Set();
  let previous = null;
  for (const item of items) {
    if (item.category !== previous && seen.has(item.category)) {
      errors.push(`${item.slug}: category "${item.category}" is split across the file; group entries by category`);
    }
    seen.add(item.category);
    previous = item.category;
  }
  return errors;
}

const items = yaml.load(fs.readFileSync(ITEMS_FILE, "utf8"));
const errors = validate(items);
if (errors.length) {
  console.error("Build stopped. Fix these entries in projects_utils/projects_items.yml:");
  errors.forEach((e) => console.error("  - " + e));
  process.exit(1);
}

// Check the sidebar markers before writing any page, so a failure cannot leave a partial build.
const quarto = fs.readFileSync(QUARTO_FILE, "utf8");
const start = quarto.indexOf(`    ${BEGIN}`);
const endMarker = quarto.indexOf(`    ${END}`);
if (start === -1 || endMarker === -1) throw new Error("Sidebar markers not found in _quarto.yml");

const OVERVIEW_FILE = path.join(ROOT, "projects.qmd");
const NAV_BEGIN = "<!-- BEGIN generated: projects-nav -->";
const NAV_END = "<!-- END generated: projects-nav -->";
const overview = fs.readFileSync(OVERVIEW_FILE, "utf8");
const navStart = overview.indexOf(NAV_BEGIN);
const navEndMarker = overview.indexOf(NAV_END);
if (navStart === -1 || navEndMarker === -1) throw new Error("Navigation markers not found in projects.qmd");

// ---- 2. Pages ------------------------------------------------------------
fs.mkdirSync(PAGES_DIR, { recursive: true });
const render = ejs.compile(fs.readFileSync(TEMPLATE_FILE, "utf8"));
const cell = (s) => String(s).replace(/\|/g, "/");
const wanted = new Set();
let written = 0;

for (const item of items) {
  const fileName = `${item.slug}.qmd`;
  wanted.add(fileName);
  if (writeIfChanged(path.join(PAGES_DIR, fileName), render({ item, cell }))) written++;
}

// Remove generated pages whose entry has been deleted. Only files carrying the generated marker
// are removed, so hand-written pages are never touched. Pages from the earlier qmds/ layout are
// cleared too, and the folder is removed if it is left empty.
const removed = [];
function removeStale(dir, keep) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".qmd") || (keep && keep.has(f))) continue;
    const full = path.join(dir, f);
    if (fs.readFileSync(full, "utf8").includes(GENERATED_MARK)) {
      fs.unlinkSync(full);
      removed.push(path.relative(ROOT, full));
    }
  }
}
removeStale(PAGES_DIR, wanted);
removeStale(LEGACY_DIR, null);
if (fs.existsSync(LEGACY_DIR) && fs.readdirSync(LEGACY_DIR).length === 0) fs.rmdirSync(LEGACY_DIR);

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

const afterEnd = quarto.indexOf("\n", endMarker) + 1;
const sidebarWritten = writeIfChanged(QUARTO_FILE, quarto.slice(0, start) + lines.join("\n") + "\n" + quarto.slice(afterEnd));

// Inline navigation on projects.qmd: one bullet per section, with each project indented beneath it.
const navLines = [NAV_BEGIN];
for (const [category, group] of sections) {
  navLines.push(`- **${category}**`);
  for (const item of group) navLines.push(`  - [${item.nav_title}](projects/${item.slug}.qmd)`);
}
navLines.push(NAV_END);
const navAfterEnd = overview.indexOf("\n", navEndMarker) + 1;
const navWritten = writeIfChanged(OVERVIEW_FILE, overview.slice(0, navStart) + navLines.join("\n") + "\n" + overview.slice(navAfterEnd));

console.log(
  `Validated ${items.length} entries. ${written} page${written === 1 ? "" : "s"} written, ` +
  `${items.length - written} unchanged. Removed ${removed.length} stale page${removed.length === 1 ? "" : "s"}. ` +
  `Sidebar ${sidebarWritten ? "updated" : "unchanged"}. Project navigation ${navWritten ? "updated" : "unchanged"}.`
);
