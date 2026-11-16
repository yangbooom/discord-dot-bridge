# Initial deploy and activation

The initial template deliberately declares only disabled feature flags. It does not ask for Discord, Access, callback, or R2 values. Choose account/repository/Worker names and retain the build commands. Actual hosted form rendering must still be checked.

This creates an inert Worker, not a usable Discord connection. workers.dev and previews remain disabled. Add a custom domain, Discord settings and bot-token secret, owner-only Managed OAuth Access configuration, and MCP_HOST / ACCESS_ISSUER / ACCESS_AUD / ACCESS_SUBJECT before enabling MCP. Follow EVENTS-IMPLEMENTATION.md for R2, encryption secret and callback verification. Keep intake and Events disabled until their acceptance tests pass.

Do not enter placeholder credentials to satisfy forms. BRIDGE_API_TOKEN belongs only to the disabled legacy HTTP mode and is not needed for MCP.

Persist non-secret settings in your deployment configuration before later Git-driven deploys; a future deploy may replace dashboard-only variables. Store credentials only in Worker Secrets, never Git.
