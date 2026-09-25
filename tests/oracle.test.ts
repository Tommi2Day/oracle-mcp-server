import { describe, it, expect } from "vitest";
import {
  parseConnectString, buildHostConnectString, connectionFromEnv, mergeConnection,
  resolvePoolAttributes, describeConnection, redactConnectString, normalizeSql, isPlsql,
  usesTcps, extractJdbcCredentials, getDriverMode, trustedCaFile, inspectWallet,
} from "../src/oracle.js";

describe("parseConnectString", () => {
  it.each([
    ["jdbc:oracle:thin:@dbhost:1521/ORCLPDB1", "dbhost:1521/ORCLPDB1"],
    ["jdbc:oracle:thin:@//dbhost:1521/ORCLPDB1", "dbhost:1521/ORCLPDB1"],
    ["jdbc:oracle:thin:@tcps://dbhost:2484/svc", "tcps://dbhost:2484/svc"],
    ["jdbc:oracle:thin:@MYALIAS", "MYALIAS"],
    ["JDBC:ORACLE:THIN:@dbhost:1521/svc", "dbhost:1521/svc"],
    ["dbhost:1521/svc", "dbhost:1521/svc"],
    ["//dbhost:1521/svc", "dbhost:1521/svc"],
    ["tcps://dbhost:2484/svc?ssl_server_dn_match=true", "tcps://dbhost:2484/svc?ssl_server_dn_match=true"],
    ["myalias", "myalias"],
  ])("%s → %s", (input, expected) => {
    expect(parseConnectString(input).connectString).toBe(expected);
  });

  it("converts the JDBC host:port:SID form into a descriptor", () => {
    expect(parseConnectString("jdbc:oracle:thin:@dbhost:1521:ORCL").connectString).toBe(
      "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=dbhost)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))");
  });

  it("converts host:port:SID without jdbc prefix", () => {
    expect(parseConnectString("db.example.com:1521:XE").connectString).toContain("(SID=XE)");
  });

  it("keeps a full connect descriptor unchanged", () => {
    const d = "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=h)(PORT=2484))(CONNECT_DATA=(SERVICE_NAME=s)))";
    expect(parseConnectString(`jdbc:oracle:thin:@${d}`).connectString).toBe(d);
    expect(parseConnectString(d).connectString).toBe(d);
  });

  it("extracts user and password from a JDBC URL", () => {
    const p = parseConnectString("jdbc:oracle:thin:scott/tiger@dbhost:1521/svc");
    expect(p).toMatchObject({ user: "scott", password: "tiger", connectString: "dbhost:1521/svc" });
  });

  it("extracts quoted JDBC credentials", () => {
    const p = parseConnectString('jdbc:oracle:thin:"scott"/"t/ig"@h:1521/s');
    expect(p.user).toBe("scott");
  });

  it("maps TNS_ADMIN URL parameter to configDir", () => {
    const p = parseConnectString("jdbc:oracle:thin:@prod_high?TNS_ADMIN=/opt/wallet");
    expect(p).toMatchObject({ connectString: "prod_high", configDir: "/opt/wallet" });
  });

  it("maps TNS_ADMIN after a descriptor", () => {
    const p = parseConnectString("jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=h)))?TNS_ADMIN=/w");
    expect(p).toMatchObject({ connectString: "(DESCRIPTION=(ADDRESS=(HOST=h)))", configDir: "/w" });
  });

  it("drops JDBC-only dotted properties and keeps Easy Connect Plus params", () => {
    const p = parseConnectString("tcps://h:2484/s?oracle.net.ssl_version=1.2&wallet_location=/w&TNS_ADMIN=/t");
    expect(p.connectString).toBe("tcps://h:2484/s?wallet_location=/w");
    expect(p.ignoredParams).toEqual(["oracle.net.ssl_version"]);
    expect(p.configDir).toBe("/t");
  });
});

describe("buildHostConnectString", () => {
  it("builds Easy Connect for tcp", () => {
    expect(buildHostConnectString({ host: "db", port: 1521, service_name: "PDB1" })).toBe("db:1521/PDB1");
  });
  it("builds tcps:// for tcps", () => {
    expect(buildHostConnectString({ host: "db", port: "2484", service_name: "PDB1", protocol: "TCPS" })).toBe("tcps://db:2484/PDB1");
  });
  it("defaults port to 1521 and allows no service", () => {
    expect(buildHostConnectString({ host: "db" })).toBe("db:1521");
  });
  it("uses a descriptor for sid", () => {
    expect(buildHostConnectString({ host: "db", sid: "ORCL", protocol: "tcps", port: 2484 })).toBe(
      "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=db)(PORT=2484))(CONNECT_DATA=(SID=ORCL)))");
  });
  it("brackets IPv6 hosts", () => {
    expect(buildHostConnectString({ host: "::1", service_name: "s" })).toBe("[::1]:1521/s");
  });
  it("rejects invalid protocol, port and missing host", () => {
    expect(() => buildHostConnectString({ host: "db", protocol: "ipc" })).toThrow(/protocol/);
    expect(() => buildHostConnectString({ host: "db", port: "abc" })).toThrow(/port/);
    expect(() => buildHostConnectString({})).toThrow(/host is required/);
  });
});

describe("connectionFromEnv", () => {
  it("reads ORA_* variables", () => {
    const c = connectionFromEnv({
      ORA_HOST: "db", ORA_PORT: "1522", ORA_SERVICE_NAME: "svc", ORA_PROTOCOL: "tcps",
      ORA_USER: "u", ORA_PASSWORD: "p", TNS_ADMIN: "/tns", ORA_WALLET_PASSWORD: "wp",
      ORA_SSL_SERVER_DN_MATCH: "false",
    });
    expect(c).toEqual({
      host: "db", port: "1522", service_name: "svc", protocol: "tcps", user: "u", password: "p",
      tns_admin: "/tns", wallet_password: "wp", ssl_server_dn_match: "false",
    });
  });
  it("defaults to localhost when no target is set", () => {
    expect(connectionFromEnv({})).toEqual({ host: "localhost" });
  });
  it("does not add a host when a TNS alias is set", () => {
    expect(connectionFromEnv({ ORA_TNS_ALIAS: "PROD" })).toEqual({ tns_alias: "PROD" });
  });
});

describe("getDriverMode", () => {
  it("defaults to thin", () => {
    expect(getDriverMode({})).toBe("thin");
    expect(getDriverMode({ ORA_DRIVER_MODE: "THICK" })).toBe("thick");
    expect(getDriverMode({ ORA_DRIVER_MODE: "other" })).toBe("thin");
  });
});

describe("mergeConnection", () => {
  const base = { host: "defhost", port: "1521", service_name: "DEF", user: "admin", password: "pw", tns_admin: "/tns" };

  it("returns the base for null", () => {
    expect(mergeConnection(null, base)).toEqual(base);
  });
  it("takes the whole target from the token without mixing base host fields", () => {
    const m = mergeConnection({ tns_alias: "PROD", user: "app", password: "x" }, base);
    expect(m).toEqual({ tns_alias: "PROD", user: "app", password: "x", tns_admin: "/tns" });
  });
  it("keeps the base target when the token only sets credentials", () => {
    const m = mergeConnection({ user: "app", password: "x" }, base);
    expect(m).toMatchObject({ host: "defhost", service_name: "DEF", user: "app", password: "x" });
  });
  it("does not inherit the base password for a different user", () => {
    expect(mergeConnection({ user: "app" }, base).password).toBeUndefined();
  });
  it("inherits base credentials when the token sets no user", () => {
    expect(mergeConnection({ host: "other" }, base)).toMatchObject({ host: "other", user: "admin", password: "pw" });
  });
});

describe("resolvePoolAttributes", () => {
  it("passes thin mode network options", () => {
    const a = resolvePoolAttributes({
      host: "h", service_name: "s", protocol: "tcps", user: "u", password: "p",
      tns_admin: "/tns", wallet_location: "/w", wallet_password: "wp",
      ssl_server_dn_match: "false", ssl_server_cert_dn: "CN=db",
    }, { inspectWallet: () => "key" });
    expect(a).toMatchObject({
      user: "u", password: "p", connectString: "tcps://h:1521/s", configDir: "/tns",
      walletLocation: "/w", walletPassword: "wp", sslServerDNMatch: false, sslServerCertDN: "CN=db",
      poolMin: 0, poolMax: 5,
    });
  });
  it("uses TNS_ADMIN as wallet location when its ewallet.pem has a key", () => {
    const a = resolvePoolAttributes({ tns_alias: "X", tns_admin: "/tns" }, { inspectWallet: d => d === "/tns" ? "key" : "none" });
    expect(a.walletLocation).toBe("/tns");
    expect(trustedCaFile({ tns_alias: "X", tns_admin: "/tns" }, { inspectWallet: () => "key" })).toBeUndefined();
  });
  it("treats a certificate-only ewallet.pem as trusted CA file instead of wallet", () => {
    const c = { tns_alias: "X", tns_admin: "/tns" };
    expect(resolvePoolAttributes(c, { inspectWallet: () => "ca" }).walletLocation).toBeUndefined();
    expect(trustedCaFile(c, { inspectWallet: () => "ca" })?.replaceAll("\\", "/")).toBe("/tns/ewallet.pem");
    const w = { host: "h", wallet_location: "/w" };
    expect(resolvePoolAttributes(w, { inspectWallet: () => "ca" }).walletLocation).toBeUndefined();
    expect(trustedCaFile(w, { inspectWallet: () => "ca" })?.replaceAll("\\", "/")).toBe("/w/ewallet.pem");
    expect(trustedCaFile(w, { mode: "thick", inspectWallet: () => "ca" })).toBeUndefined();
  });
  it("passes an explicit wallet_location through when it cannot be inspected", () => {
    expect(resolvePoolAttributes({ host: "h", wallet_location: "/w" }, { inspectWallet: () => "none" }).walletLocation).toBe("/w");
  });
  it("does not set a wallet when none is found", () => {
    const a = resolvePoolAttributes({ tns_alias: "X", tns_admin: "/tns" }, { inspectWallet: () => "none" });
    expect(a.walletLocation).toBeUndefined();
  });
  it("omits network options in thick mode", () => {
    const a = resolvePoolAttributes({ tns_alias: "X", tns_admin: "/tns", wallet_location: "/w", ssl_server_dn_match: true },
      { mode: "thick", inspectWallet: () => "key" });
    expect(a).not.toHaveProperty("configDir");
    expect(a).not.toHaveProperty("walletLocation");
    expect(a).not.toHaveProperty("sslServerDNMatch");
  });
  it("prefers JDBC URL credentials and TNS_ADMIN", () => {
    const a = resolvePoolAttributes({ connect_string: "jdbc:oracle:thin:a/b@x?TNS_ADMIN=/j", user: "u", tns_admin: "/tns" },
      { inspectWallet: () => "none" });
    expect(a).toMatchObject({ user: "a", password: "b", connectString: "x", configDir: "/j" });
  });
});

describe("extractJdbcCredentials", () => {
  it("moves credentials to user/password", () => {
    expect(extractJdbcCredentials({ connect_string: "jdbc:oracle:thin:scott/tiger@h:1521/s" })).toEqual({
      connect_string: "jdbc:oracle:thin:@h:1521/s", user: "scott", password: "tiger",
    });
  });
  it("keeps explicit user/password", () => {
    expect(extractJdbcCredentials({ connect_string: "jdbc:oracle:thin:a/b@h/s", user: "u", password: "p" }))
      .toMatchObject({ user: "u", password: "p", connect_string: "jdbc:oracle:thin:@h/s" });
  });
  it("leaves other strings alone", () => {
    const c = { connect_string: "jdbc:oracle:thin:@h/s" };
    expect(extractJdbcCredentials(c)).toBe(c);
  });
});

describe("describeConnection", () => {
  it("describes a host connection without password", () => {
    const d = describeConnection({ host: "h", port: "2484", service_name: "s", protocol: "tcps", user: "u", password: "secret" });
    expect(d).toMatchObject({ type: "host", host: "h", port: 2484, protocol: "tcps", user: "u", connect_string: "tcps://h:2484/s" });
    expect(JSON.stringify(d)).not.toContain("secret");
  });
  it("describes an alias", () => {
    expect(describeConnection({ tns_alias: "PROD" })).toMatchObject({ type: "tns_alias", tns_alias: "PROD" });
    expect(describeConnection({ tns_alias: "PROD" }).protocol).toBeUndefined();
  });
  it("reports errors instead of throwing", () => {
    expect(describeConnection({ host: "h", protocol: "bad" }).error).toMatch(/protocol/);
  });
  it("redacts wallet passwords", () => {
    expect(redactConnectString("tcps://h/s?wallet_password=abc&x=1")).toBe("tcps://h/s?wallet_password=***&x=1");
  });
});

describe("usesTcps", () => {
  it("detects TCPS", () => {
    expect(usesTcps("tcps://h:2484/s")).toBe(true);
    expect(usesTcps("(DESCRIPTION=(ADDRESS=(PROTOCOL = tcps)(HOST=h)))")).toBe(true);
    expect(usesTcps("h:1521/s")).toBe(false);
  });
});

describe("normalizeSql / isPlsql", () => {
  it("strips trailing semicolons from SQL", () => {
    expect(normalizeSql("SELECT * FROM dual;  ")).toBe("SELECT * FROM dual");
  });
  it("keeps semicolons on PL/SQL and strips a trailing slash", () => {
    expect(normalizeSql("BEGIN NULL; END;\n/\n")).toBe("BEGIN NULL; END;");
    expect(normalizeSql("create or replace procedure p as begin null; end;")).toMatch(/end;$/);
  });
  it("detects PL/SQL after comments", () => {
    expect(isPlsql("-- c\n/* x */ DECLARE x NUMBER; BEGIN NULL; END;")).toBe(true);
    expect(isPlsql("CREATE OR REPLACE EDITIONABLE PACKAGE BODY p AS END;")).toBe(true);
    expect(isPlsql("CREATE TABLE t (x NUMBER)")).toBe(false);
  });
});

describe("inspectWallet", () => {
  it("classifies ewallet.pem files", async () => {
    const os = await import("node:os"); const fs = await import("node:fs"); const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-"));
    expect(inspectWallet(dir)).toBe("none");
    fs.writeFileSync(path.join(dir, "ewallet.pem"), "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n");
    expect(inspectWallet(dir)).toBe("ca");
    fs.appendFileSync(path.join(dir, "ewallet.pem"), "-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n");
    expect(inspectWallet(dir)).toBe("key");
    fs.rmSync(dir, { recursive: true });
  });
});
