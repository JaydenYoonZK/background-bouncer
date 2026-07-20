# Security Policy

## Reporting a vulnerability

If you find a security issue in Background Begone, please open a [private security advisory](https://github.com/JaydenYoonZK/background-begone/security/advisories/new) or email claude@jaydenart.com. Please do not open a public issue for security reports.

## Scope

The tool runs entirely in the browser. There is no server, no account system, and no data storage: the page's Content Security Policy (`connect-src 'self'`) prevents any network request beyond the page's own files. Reports about ways to defeat that isolation, to exfiltrate an image, or to execute untrusted code through a crafted image file are very much in scope.

## Supported versions

Only the latest deployed version at https://jaydenyoonzk.github.io/background-begone/ is supported.
