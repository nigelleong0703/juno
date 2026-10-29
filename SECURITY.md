# Security

For a suspected vulnerability, use GitHub private vulnerability reporting on this repository when enabled. Do not put credentials, private conversations or exploit details affecting deployed users into a public issue. If private reporting is unavailable, open a minimal issue asking for a private contact without disclosing the vulnerability.

Juno runs agents that call external models and tools. Deploy only to infrastructure you administer. Model-provider terms and network behavior still apply. Follow deploy/README.md for persistent data, secrets, TLS and service exposure.

Treat access to a Docker daemon as host-administrator access. Use a dedicated host for Docker-managed agent computers. Do not publish internal agentd/computerd ports or a Docker socket. Use separate origins for generated content and the authenticated app, as enforced by the API configuration.

Use dedicated demonstration accounts. Never include production secrets or conversation exports in bug reports; redact diagnostic data before sharing it.
