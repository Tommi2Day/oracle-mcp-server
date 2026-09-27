/**
 * Admin UI branding: corporate logo and colors.
 *
 *   ADMIN_THEME_CSS – CSS file appended after the built-in styles (override the :root variables)
 *   ADMIN_LOGO      – logo file (svg/png/jpg/gif/webp, embedded as data URI) or http(s) URL
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "./lib.js";

export interface AdminBranding {
  /** Additional stylesheet, injected after the built-in one. */
  css?: string;
  /** Logo `src` (data URI or URL); replaces the built-in database icon. */
  logoSrc?: string;
}

const LOGO_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Converts a logo file into a data URI; throws on unsupported file types. */
export function logoDataUri(file: string): string {
  const mime = LOGO_TYPES[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`unsupported logo type "${path.extname(file)}" (use ${Object.keys(LOGO_TYPES).join(", ")})`);
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

/** Reads ADMIN_THEME_CSS / ADMIN_LOGO; unreadable files are logged and skipped (built-in design). */
export function loadAdminBranding(env: NodeJS.ProcessEnv = process.env): AdminBranding {
  const branding: AdminBranding = {};
  if (env.ADMIN_THEME_CSS) {
    try {
      branding.css = fs.readFileSync(env.ADMIN_THEME_CSS, "utf8");
      log("info", "CONFIG", `Admin UI theme: ${env.ADMIN_THEME_CSS}`);
    } catch (err) {
      log("warn", "CONFIG", `ADMIN_THEME_CSS ignored: ${(err as Error).message}`);
    }
  }
  if (env.ADMIN_LOGO) {
    try {
      branding.logoSrc = /^https?:\/\//i.test(env.ADMIN_LOGO) ? env.ADMIN_LOGO : logoDataUri(env.ADMIN_LOGO);
      log("info", "CONFIG", `Admin UI logo: ${env.ADMIN_LOGO}`);
    } catch (err) {
      log("warn", "CONFIG", `ADMIN_LOGO ignored: ${(err as Error).message}`);
    }
  }
  return branding;
}

/** Fills the admin.html template: server name, optional theme stylesheet and logo. */
export function renderAdminHtml(template: string, serverName: string, branding: AdminBranding = {}): string {
  let html = template.replaceAll("__SERVER_NAME__", escapeHtml(serverName));
  if (branding.css) {
    html = html.replace("<!--theme-->", () => `<style id="admin-theme">\n${branding.css}\n</style>`);
  }
  if (branding.logoSrc) {
    const img = `<img src="${escapeHtml(branding.logoSrc)}" alt="${escapeHtml(serverName)}">`;
    html = html
      .replace(/class="(brand-icon|header-brand-icon)"><!--logo-->[\s\S]*?<!--\/logo-->/g, (_m, cls: string) => `class="${cls} custom-logo">${img}`);
  }
  return html;
}
