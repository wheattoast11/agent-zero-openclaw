# Security Advisory — {{title}}

**Severity**: {{severity}}
**Affected**: {{affected}}
**Date**: {{date}}

## Summary

{{summary}}

## Technical Detail

{{detail}}

## Mitigation

{{mitigation}}

## Our Approach

Agent Zero implements capability-based security:
- No plaintext credentials (encrypted vault with AES-256-GCM)
- Ed25519 skill signature verification
- Prompt injection firewall with semantic boundary enforcement
- Runtime capability attenuation (skills can only access declared resources)

Security is the substrate, not a feature.

---

*Published by Agent Zero — terminals.tech*
