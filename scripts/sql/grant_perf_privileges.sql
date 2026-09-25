-- ============================================================================
-- grant_perf_privileges.sql
--
-- Grants the database privileges needed by the oracle-mcp-server performance
-- tools (see docs/performance.md) to the user the server connects with.
--
-- Usage (SQL*Plus / SQLcl, as SYS or another user allowed to grant on SYS objects):
--
--   @grant_perf_privileges.sql <user> [mode] [diagnostics] [tuning]
--
--   user         database user of the MCP server (unquoted names are upper-cased)
--   mode         MINIMAL (default) – roles with SELECT on exactly the views the tools use:
--                                    MCP_PERF_ROLE        unlicensed tools
--                                    MCP_PERF_DIAG_ROLE   Diagnostics Pack tools
--                                    MCP_PERF_TUNING_ROLE Tuning Pack tools
--                CATALOG           – SELECT_CATALOG_ROLE (broad read access to the
--                                    whole dictionary, includes pack-licensed views)
--   diagnostics  Y | N (default N) – also grant the Diagnostics Pack views
--                                    (ASH, AWR). Only with a Diagnostics Pack licence!
--   tuning       Y | N (default N) – also grant the Tuning Pack objects
--                                    (SQL Monitor). Only with a Tuning Pack licence!
--
-- Examples:
--   sqlplus / as sysdba
--   SQL> ALTER SESSION SET CONTAINER = FREEPDB1;        -- multitenant: run in the PDB
--   SQL> @grant_perf_privileges.sql MCP
--   SQL> @grant_perf_privileges.sql MCP MINIMAL Y Y
--   SQL> @grant_perf_privileges.sql MCP CATALOG
--
-- The script sets the desired state and is idempotent: running it with
-- diagnostics/tuning = N revokes a previously granted pack role from the user
-- (the pack roles are separate, so other users' licence settings are unaffected). Objects that do not exist in the database version
-- (e.g. AWR_ROOT_* before 12.2) are reported as SKIP. New roles take effect for
-- new sessions only: restart the MCP server (or wait for new pool sessions).
-- Revoke with revoke_perf_privileges.sql.
-- ============================================================================

SET VERIFY OFF FEEDBACK OFF LINESIZE 200 SERVEROUTPUT ON SIZE UNLIMITED FORMAT WRAPPED

-- optional positional parameters: define empty defaults for &2..&4
COLUMN 2 NEW_VALUE 2 NOPRINT
COLUMN 3 NEW_VALUE 3 NOPRINT
COLUMN 4 NEW_VALUE 4 NOPRINT
SELECT '' "2", '' "3", '' "4" FROM dual WHERE 1 = 0;

DEFINE mcp_user     = "&1"
DEFINE mcp_mode     = "&2"
DEFINE mcp_diag     = "&3"
DEFINE mcp_tuning   = "&4"

DECLARE
  c_role   CONSTANT VARCHAR2(30) := 'MCP_PERF_ROLE';
  c_diag   CONSTANT VARCHAR2(30) := 'MCP_PERF_DIAG_ROLE';
  c_tuning CONSTANT VARCHAR2(30) := 'MCP_PERF_TUNING_ROLE';
  v_user   VARCHAR2(128) := '&mcp_user';
  v_mode   VARCHAR2(10)  := UPPER(NVL('&mcp_mode', 'MINIMAL'));
  v_diag   BOOLEAN       := UPPER(NVL('&mcp_diag', 'N')) IN ('Y', 'YES', 'TRUE', '1');
  v_tuning BOOLEAN       := UPPER(NVL('&mcp_tuning', 'N')) IN ('Y', 'YES', 'TRUE', '1');
  v_cnt    PLS_INTEGER;
  v_errors PLS_INTEGER := 0;

  PROCEDURE run(p_sql VARCHAR2, p_optional BOOLEAN := FALSE) IS
  BEGIN
    EXECUTE IMMEDIATE p_sql;
    DBMS_OUTPUT.PUT_LINE('OK    ' || p_sql);
  EXCEPTION
    WHEN OTHERS THEN
      IF p_optional THEN
        DBMS_OUTPUT.PUT_LINE('SKIP  ' || p_sql || '  -- ' || SQLERRM);
      ELSE
        DBMS_OUTPUT.PUT_LINE('FAIL  ' || p_sql || '  -- ' || SQLERRM);
        v_errors := v_errors + 1;
      END IF;
  END;

  -- SELECT on a SYS object; objects missing in older releases are optional
  PROCEDURE grant_select(p_object VARCHAR2, p_role VARCHAR2, p_optional BOOLEAN := FALSE) IS
  BEGIN
    run('GRANT SELECT ON SYS.' || p_object || ' TO ' || p_role, p_optional);
  END;

  PROCEDURE ensure_role(p_role VARCHAR2) IS
    v_n PLS_INTEGER;
  BEGIN
    SELECT COUNT(*) INTO v_n FROM dba_roles WHERE role = p_role;
    IF v_n = 0 THEN
      run('CREATE ROLE ' || p_role);
    END IF;
  END;

  -- grant or (when not wanted) revoke a role from the user
  PROCEDURE set_role(p_role VARCHAR2, p_wanted BOOLEAN) IS
    v_n PLS_INTEGER;
  BEGIN
    SELECT COUNT(*) INTO v_n FROM dba_role_privs WHERE grantee = v_user AND granted_role = p_role;
    IF p_wanted THEN
      run('GRANT ' || p_role || ' TO "' || v_user || '"');
    ELSIF v_n > 0 THEN
      run('REVOKE ' || p_role || ' FROM "' || v_user || '"');
    END IF;
  END;
BEGIN
  -- unquoted names follow Oracle rules: upper-case; "Quoted" names stay as given
  IF v_user LIKE '"%"' THEN
    v_user := SUBSTR(v_user, 2, LENGTH(v_user) - 2);
  ELSE
    v_user := UPPER(v_user);
  END IF;

  SELECT COUNT(*) INTO v_cnt FROM dba_users WHERE username = v_user;
  IF v_cnt = 0 THEN
    RAISE_APPLICATION_ERROR(-20001, 'User ' || v_user || ' does not exist in this container');
  END IF;
  IF v_mode NOT IN ('MINIMAL', 'CATALOG') THEN
    RAISE_APPLICATION_ERROR(-20002, 'mode must be MINIMAL or CATALOG, not ' || v_mode);
  END IF;

  DBMS_OUTPUT.PUT_LINE('oracle-mcp-server performance privileges for ' || v_user
    || ' – mode ' || v_mode
    || ', Diagnostics Pack ' || CASE WHEN v_diag THEN 'Y' ELSE 'N' END
    || ', Tuning Pack ' || CASE WHEN v_tuning THEN 'Y' ELSE 'N' END);
  DBMS_OUTPUT.PUT_LINE('');

  IF v_mode = 'CATALOG' THEN
    -- Broad read access to all V$/DBA_ views, including ASH/AWR/SQL Monitor data.
    -- Pack usage is then only prevented by the server switches ORA_DIAGNOSTICS_PACK /
    -- ORA_TUNING_PACK (and the generic query tool could read the licensed views).
    run('GRANT SELECT_CATALOG_ROLE TO "' || v_user || '"');
    IF v_tuning THEN
      run('GRANT EXECUTE ON SYS.DBMS_SQLTUNE TO "' || v_user || '"');
    END IF;
  ELSE
    ensure_role(c_role);

    -- explain_plan: no privileges (PLAN_TABLE and DBMS_XPLAN are public)
    -- table_stats : no privileges (ALL_* views, tables the user can access)

    -- sql_plan (DBMS_XPLAN.DISPLAY_CURSOR)
    grant_select('V_$SQL', c_role);
    grant_select('V_$SQL_PLAN', c_role);
    grant_select('V_$SQL_PLAN_STATISTICS_ALL', c_role);
    grant_select('V_$SESSION', c_role);
    -- top_sql
    grant_select('V_$SQLAREA', c_role);
    -- session_activity (V$SESSION above)
    grant_select('V_$SYSTEM_EVENT', c_role);
    set_role(c_role, TRUE);

    -- Diagnostics Pack: ash_top, awr_top_events (role only created when requested)
    IF v_diag THEN
      ensure_role(c_diag);
      grant_select('V_$ACTIVE_SESSION_HISTORY', c_diag);
      grant_select('DBA_HIST_SNAPSHOT', c_diag);
      grant_select('DBA_HIST_SYS_TIME_MODEL', c_diag);
      grant_select('DBA_HIST_SYSTEM_EVENT', c_diag);
      -- CDB root AWR data seen from a PDB (12.2+)
      grant_select('AWR_ROOT_SNAPSHOT', c_diag, TRUE);
      grant_select('AWR_ROOT_SYS_TIME_MODEL', c_diag, TRUE);
      grant_select('AWR_ROOT_SYSTEM_EVENT', c_diag, TRUE);
      -- hint "pack disabled in the database" (CONTROL_MANAGEMENT_PACK_ACCESS)
      grant_select('V_$PARAMETER', c_diag);
    END IF;
    set_role(c_diag, v_diag);

    -- Tuning Pack: sql_monitor (role only created when requested)
    IF v_tuning THEN
      ensure_role(c_tuning);
      grant_select('V_$SQL_MONITOR', c_tuning);
      grant_select('V_$SQL_PLAN_MONITOR', c_tuning);
      grant_select('V_$PARAMETER', c_tuning);
      run('GRANT EXECUTE ON SYS.DBMS_SQLTUNE TO ' || c_tuning);
    END IF;
    set_role(c_tuning, v_tuning);
  END IF;

  -- roles only work in SQL if they are default roles of the user
  SELECT COUNT(*) INTO v_cnt
    FROM dba_role_privs
   WHERE grantee = v_user
     AND granted_role IN ('SELECT_CATALOG_ROLE', c_role, c_diag, c_tuning)
     AND default_role = 'NO';
  IF v_cnt > 0 THEN
    DBMS_OUTPUT.PUT_LINE('WARN  the role is not a default role of ' || v_user
      || ' – run: ALTER USER "' || v_user || '" DEFAULT ROLE ALL');
  END IF;

  DBMS_OUTPUT.PUT_LINE('');
  IF v_errors > 0 THEN
    DBMS_OUTPUT.PUT_LINE(v_errors || ' grant(s) failed – run as SYS (or a user with GRANT ANY OBJECT PRIVILEGE).');
  ELSE
    DBMS_OUTPUT.PUT_LINE('Done. Reconnect (restart the MCP server) so new sessions pick up the privileges.');
    IF v_diag OR v_tuning THEN
      DBMS_OUTPUT.PUT_LINE('Enable the licensed tools in the server: ORA_DIAGNOSTICS_PACK / ORA_TUNING_PACK = true');
      DBMS_OUTPUT.PUT_LINE('or per token with diagnostics_pack / tuning_pack.');
    END IF;
  END IF;
END;
/

UNDEFINE 1 2 3 4 mcp_user mcp_mode mcp_diag mcp_tuning
SET VERIFY ON FEEDBACK ON
