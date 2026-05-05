# Security Policy

## Reporting a Vulnerability

Please report vulnerabilities privately through GitHub Security Advisories:
`https://github.com/yadimon/llm-clash/security/advisories/new`.

Do not include API keys, prompts containing secrets, or private run artifacts in
public issues.

## Runtime Notes

`multidraft` passes prompts to configured model providers or local commands.
Review provider and command configuration before running sensitive tasks.
