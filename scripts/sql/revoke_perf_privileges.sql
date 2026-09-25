-- ============================================================================
-- revoke_perf_privileges.sql
--
-- Removes the privileges granted by grant_perf_privileges.sql.
--
-- Usage (SQL*Plus / SQLcl, as SYS):
--   @revoke_perf_privileges.sql <user> [drop_role]
--
--   user       database user of the MCP server
--   drop_role  Y | N (default N) – also drop the MCP_PERF_* roles (affects every grantee)
--
-- SELECT_CATALOG_ROLE is revoked too if the user has it — skip that step manually
-- if the user needs the role for other purposes.
-- ============================================================================

SET VERIFY OFF FEEDBACK OFF LINESIZE 200 SERVEROUTPUT ON SIZE UNLIMITED FORMAT WRAPPED

COLUMN 2 NEW_VALUE 2 NOPRINT
SELECT '' "2" FROM dual WHERE 1 = 0;

DEFINE mcp_user = "&1"
DEFINE mcp_drop = "&2"

DECLARE
  TYPE t_roles IS TABLE OF VARCHAR2(30);
  c_roles CONSTANT t_roles := t_roles('MCP_PERF_ROLE', 'MCP_PERF_DIAG_ROLE', 'MCP_PERF_TUNING_ROLE');
  v_user VARCHAR2(128) := '&mcp_user';
  v_drop BOOLEAN       := UPPER(NVL('&mcp_drop', 'N')) IN ('Y', 'YES', 'TRUE', '1');

  PROCEDURE run(p_sql VARCHAR2) IS
  BEGIN
    EXECUTE IMMEDIATE p_sql;
    DBMS_OUTPUT.PUT_LINE('OK    ' || p_sql);
  EXCEPTION
    WHEN OTHERS THEN
      DBMS_OUTPUT.PUT_LINE('SKIP  ' || p_sql || '  -- ' || SQLERRM);
  END;
BEGIN
  IF v_user LIKE '"%"' THEN
    v_user := SUBSTR(v_user, 2, LENGTH(v_user) - 2);
  ELSE
    v_user := UPPER(v_user);
  END IF;

  FOR i IN 1 .. c_roles.COUNT LOOP
    run('REVOKE ' || c_roles(i) || ' FROM "' || v_user || '"');
  END LOOP;
  run('REVOKE SELECT_CATALOG_ROLE FROM "' || v_user || '"');
  run('REVOKE EXECUTE ON SYS.DBMS_SQLTUNE FROM "' || v_user || '"');
  IF v_drop THEN
    FOR i IN 1 .. c_roles.COUNT LOOP
      run('DROP ROLE ' || c_roles(i));
    END LOOP;
  END IF;
  DBMS_OUTPUT.PUT_LINE('Done. Existing sessions keep enabled roles until they reconnect.');
END;
/

UNDEFINE 1 2 mcp_user mcp_drop
SET VERIFY ON FEEDBACK ON
