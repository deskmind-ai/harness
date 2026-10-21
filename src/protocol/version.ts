/**
 * The versions of the three interfaces between the app, the executor and the runtime (docs/protocol.md): the MCP tool
 * set (tools), the app's event stream (events), and the control lines the app writes on stdin (control). Adding a
 * tool, an event kind, an optional field or a control type keeps the version; removing, renaming or changing what
 * something means bumps it, and the previous version is still accepted for one release cycle.
 */
export const PROTOCOL = { tools: 1, events: 1, control: 1 } as const;
/** The MCP revision the executor's server speaks (initialize). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
