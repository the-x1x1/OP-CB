# Product boundaries

WORLDVIEW models the physical world: aircraft, ships, satellites, earthquakes, fires,
weather, public alerts, infrastructure, public cameras, transit, and equipment the user
owns. It is a browser for places, objects and events — not a people-tracking system.

## WORLDVIEW will not intentionally implement

- named-person surveillance or person search;
- facial recognition, gait or biometric analysis;
- deanonymization or identity inference from imagery or signals;
- private-device tracking (phones, personal vehicles, consumer trackers);
- license-plate history databases or ALPR detection from camera frames (the GEV ALPR layer is removed);
- stalker workflows: following a specific individual, alerting on a private person's movements;
- brute-force camera discovery, credential attacks or exposed-camera scanning.

### The operator's own household (decision of 2026-10-20)

One exception to private-device tracking, by the operator's decision: the people and phones the
operator's **own Home Assistant** already locates (`person` and `device_tracker` entities) may
be shown, through the shipped `home-assistant-people` definition only. It is off until the
operator turns it on and gives their own server's address and token; it reads nothing Home
Assistant does not already hold; where those people were is not written to history, put in an
offline pack, exported or given to other programs — a closed data policy the connector sets in
code for any definition that reads these domains, whatever its JSON says. They are ordinary
objects of the map otherwise: searchable by name and inside watch zones like anything else, which
is why it stays off unless the people it shows agree. Every other Home Assistant definition
still drops these entities as they arrive.

## What the camera system does

Public documented cameras and user-owned cameras are placed on the map and their
frames are shown as the provider served them. Nothing detects, recognises or
classifies what is in a frame. Frames are not retained by default.

## Enforcement

- Identity resolution joins only on authoritative object identifiers (ADR-011).
- `tools/dev/product-boundary.test.ts` runs in the normal suite and fails the build if
  the identity rules grow a person-derived key, if the IPC catalogue gains a
  person-oriented channel, or if anything in the camera path starts analysing or
  storing frames. It is a drift guard, not a proof: it makes crossing this line a
  deliberate act rather than an accident.
- The threat model (docs/security/THREAT-MODEL.md) treats "misuse against a private individual" as an in-scope abuse case for feature review.
- Providers whose terms or purpose conflict with this boundary are excluded in `config/licenses/providers.json`.
