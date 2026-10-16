# Third-party notices

rabbithole_explorer's own code is MIT-licensed (see `LICENSE`). This file lists code
copied from other projects, with its licence. Copied code lives under `vendor/` and
each file starts with a header naming its source file and commit.

## Copied code

_None yet._

<!--
Template for each entry:

### <project> — <files>
- Source: <repo URL>, commit <sha>, files <paths>
- Copied to: vendor/<dir>/
- Licence: <SPDX id>; full text below or in vendor/<dir>/LICENSE
-->

## npm dependencies (bundled into the build)

| Package | Licence |
| --- | --- |
| maplibre-gl | BSD-3-Clause |
| satellite.js | MIT |

## Data and map tiles

`public/data/lora-gateways.json` is a snapshot of the Packet Broker Mapper
(https://mapper.packetbroker.net), The Things Network and peering networks, made by
`tools/fetch-gateways.mjs`: gateways with a location updated in the last 7 days, positions
rounded to ~100 m, no gateway IDs. Courtesy of Packet Broker / The Things Network.


Data sources are credited in the app (attribution line and "About the data" panel),
not here. The only third-party data stored in this repo are small test fixtures under
`public/fixtures/`:

- `aircraft-adsblol.json`: one adsb.lol API response (French Riviera, 150 nm, 13 Oct 2026),
  reduced to the fields the app uses (registrations and other details removed).
  Data © adsb.lol contributors, licensed under the Open Database Licence (ODbL) 1.0:
  https://opendatacommons.org/licenses/odbl/1-0/
- `decoder-aircraft.json`, `decoder-receiver.json`: synthetic "my decoder" data for the
  antenna overlay, derived from `aircraft-adsblol.json` (so also ODbL, © adsb.lol
  contributors) plus two made-up aircraft (`fffff0`, `fffff1`). Not a real recording.
- `quakes-usgs-2.5_week.geojson`: one USGS summary feed (US public domain), trimmed.
- `sats-*.json`: CelesTrak GP element sets (OMM JSON) for the stations, gps-ops, weather and
  visual groups, downloaded once on 14 Oct 2026. Orbital data courtesy of CelesTrak
  (https://celestrak.org/), based on public US Space Force data.
- `ships-sample.json`: AIS positions received through AISStream (https://aisstream.io) over
  7 minutes on 15 Oct 2026, Marseille–Genoa coast; pleasure craft removed, names and
  destinations blanked for vessels without a declared type. AIS data via aisstream.io.

- `webcams-sample.json`: made-up webcams (no Windy data is stored in this repo).

`public/data/live-streams.json` lists public YouTube live streams by video ID, with titles
and approximate positions written by hand; the videos belong to their channels and are only
linked or embedded with YouTube's player.

## Relay Worker (`worker/`)

Dev-only dependencies (not bundled into the app): wrangler (MIT OR Apache-2.0),
typescript (Apache-2.0).
