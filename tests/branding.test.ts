import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../src/lib.js", () => ({ log: vi.fn() }));

import { loadAdminBranding, renderAdminHtml, logoDataUri, escapeHtml } from "../src/branding.js";
import { log } from "../src/lib.js";

const template = fs.readFileSync(new URL("../admin.html", import.meta.url), "utf8");

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "branding-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe("renderAdminHtml", () => {
  it("keeps the built-in design without branding", () => {
    const html = renderAdminHtml(template, "Prod DB");
    expect(html).not.toContain("__SERVER_NAME__");
    expect(html).toContain("<h1>Prod DB</h1>");
    expect(html).not.toContain('id="admin-theme"');
    expect(html).not.toContain("custom-logo\"");
    expect(html.match(/<!--logo-->/g)).toHaveLength(2);
  });

  it("escapes the server name", () => {
    expect(renderAdminHtml(template, "<b>&")).toContain("<h1>&lt;b&gt;&amp;</h1>");
  });

  it("injects the theme stylesheet after the built-in styles", () => {
    const html = renderAdminHtml(template, "x", { css: ":root { --primary: #c00; $& }" });
    const theme = html.indexOf('<style id="admin-theme">');
    expect(theme).toBeGreaterThan(html.indexOf("</style>"));
    expect(theme).toBeLessThan(html.indexOf("</head>"));
    expect(html).toContain(":root { --primary: #c00; $& }");
  });

  it("replaces both icons with the logo", () => {
    const html = renderAdminHtml(template, "Prod", { logoSrc: "https://cdn.example.com/logo.svg?a=1&b=2" });
    expect(html.match(/class="brand-icon custom-logo"><img src="https:\/\/cdn\.example\.com\/logo\.svg\?a=1&amp;b=2" alt="Prod">/g)).toHaveLength(1);
    expect(html.match(/class="header-brand-icon custom-logo"><img /g)).toHaveLength(1);
    expect(html).not.toContain("<!--logo-->");
  });
});

describe("logoDataUri", () => {
  it("embeds the file with its media type", () => {
    const file = tmpFile("logo.SVG", "<svg/>");
    expect(logoDataUri(file)).toBe(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`);
  });

  it("rejects unsupported types", () => {
    expect(() => logoDataUri("/x/logo.bmp")).toThrow(/unsupported logo type/);
  });
});

describe("loadAdminBranding", () => {
  it("returns nothing when not configured", () => {
    expect(loadAdminBranding({})).toEqual({});
  });

  it("reads the theme file and logo", () => {
    const css = tmpFile("theme.css", ":root{--primary:red}");
    const logo = tmpFile("logo.png", "png");
    const b = loadAdminBranding({ ADMIN_THEME_CSS: css, ADMIN_LOGO: logo });
    expect(b.css).toBe(":root{--primary:red}");
    expect(b.logoSrc).toMatch(/^data:image\/png;base64,/);
  });

  it("passes logo URLs through", () => {
    expect(loadAdminBranding({ ADMIN_LOGO: "https://example.com/l.png" }).logoSrc).toBe("https://example.com/l.png");
  });

  it("falls back to the built-in design on errors", () => {
    const b = loadAdminBranding({ ADMIN_THEME_CSS: "/nonexistent/theme.css", ADMIN_LOGO: "/nonexistent/logo.png" });
    expect(b).toEqual({});
    expect(vi.mocked(log)).toHaveBeenCalledWith("warn", "CONFIG", expect.stringContaining("ADMIN_THEME_CSS ignored"));
    expect(vi.mocked(log)).toHaveBeenCalledWith("warn", "CONFIG", expect.stringContaining("ADMIN_LOGO ignored"));
  });

  it("ships a working example theme", () => {
    const dir = fileURLToPath(new URL("../examples/admin-theme/", import.meta.url));
    const b = loadAdminBranding({ ADMIN_THEME_CSS: path.join(dir, "theme.css"), ADMIN_LOGO: path.join(dir, "logo.svg") });
    expect(b.css).toContain("--primary");
    expect(b.logoSrc).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});

it("escapeHtml", () => {
  expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});
