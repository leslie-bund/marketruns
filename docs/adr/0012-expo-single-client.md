# One Expo React Native client with three roles

The mobile app is a single Expo / React Native codebase serving buyer, seller, and runner roles in one binary. We rejected native per-platform development (team size and iteration speed at launch) and separate apps per role (the roles share the camera-capture, QR-challenge, and location machinery, and one person may hold several roles). Expo is load-bearing for trust, not just convenience: camera-only capture is enforced by simply never requesting media-library permissions, and expo-location covers runner tracking and geotagged store verification.

## Consequences

- Evidence integrity depends on platform permission hygiene; any future feature requesting media-library access must be reviewed against the handoff-evidence model.
- Buyer delivery locations use plus codes (Open Location Code), not street addresses.
