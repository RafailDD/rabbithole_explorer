// Every data source the app uses or plans to use, for the "About the data" panel.
// Layers report which source ids they currently use (DataLayer.sourceIds()).

export interface DataSource {
  id: string;
  name: string;
  url: string;
  credit: string;
  terms: string;
  /** Not wired into any layer yet. */
  planned?: boolean;
}

export const SOURCES: DataSource[] = [
  {
    id: "openfreemap",
    name: "OpenFreeMap",
    url: "https://openfreemap.org/",
    credit: "OpenFreeMap © OpenMapTiles © OpenStreetMap contributors",
    terms: "Basemap tiles. Free, attribution required. OpenStreetMap data under ODbL.",
  },
  {
    id: "nominatim",
    name: "OpenStreetMap Nominatim (place search)",
    url: "https://nominatim.org/",
    credit: "Search: Nominatim, © OpenStreetMap contributors (ODbL)",
    terms: "Used only when you search a place name and press Enter (max 1 search per second). Coordinates are handled locally.",
  },
  {
    id: "eox",
    name: "Sentinel-2 cloudless by EOX",
    url: "https://s2maps.eu",
    credit: "Sentinel-2 cloudless 2023 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2023)",
    terms: "Satellite background map. CC BY-NC-SA 4.0: non-commercial use with attribution.",
  },
  {
    id: "maptiler",
    name: "MapTiler",
    url: "https://www.maptiler.com/copyright/",
    credit: "© MapTiler © OpenStreetMap contributors",
    terms: "Sharp satellite background map. Free plan with your own key, attribution required.",
  },
  {
    id: "nasagibs",
    name: "NASA EOSDIS GIBS",
    url: "https://earthdata.nasa.gov/gibs",
    credit: "Imagery: NASA EOSDIS GIBS (VIIRS true colour)",
    terms: "Yesterday's satellite imagery, about 250 m per pixel. Free; credit NASA.",
  },
  {
    id: "adsblol",
    name: "adsb.lol",
    url: "https://adsb.lol/",
    credit: "Aircraft data: adsb.lol (ODbL 1.0)",
    terms: "Open Database Licence: attribution, share-alike on derived databases.",
  },
  {
    id: "adsbfi",
    name: "adsb.fi",
    url: "https://adsb.fi/",
    credit: "Aircraft data: adsb.fi",
    terms: "Personal, non-commercial use; cite adsb.fi with a link.",
  },
  {
    id: "airplaneslive",
    name: "airplanes.live",
    url: "https://airplanes.live/",
    credit: "Aircraft data: airplanes.live",
    terms: "Non-commercial use, no SLA. Not used yet: asks apps to contact them first.",
    planned: true,
  },
  {
    id: "vrsroutes",
    name: "Virtual Radar Server standing data (via adsb.lol)",
    url: "https://github.com/vradarserver/standing-data",
    credit: "Flight routes: VRS standing data (CC0)",
    terms: "Public domain (CC0). Crowd-sourced routes by callsign; can be outdated. Fetched only for the aircraft you click.",
  },
  {
    id: "decoder",
    name: "Your own ADS-B decoder (optional)",
    url: "https://github.com/flightaware/dump1090",
    credit: "My antenna: your local decoder",
    terms: "Read directly by this browser tab from the address you enter; never uploaded or stored.",
  },
  {
    id: "usgs",
    name: "USGS Earthquake Hazards Program",
    url: "https://earthquake.usgs.gov/",
    credit: "Earthquakes: USGS",
    terms: "US public domain; courtesy credit.",
  },
  {
    id: "celestrak",
    name: "CelesTrak",
    url: "https://celestrak.org/",
    credit: "Satellite orbits: CelesTrak",
    terms: "Free; citation requested. One download per 2 h per data set (cached in your browser).",
  },
  {
    id: "packetbroker",
    name: "Packet Broker / The Things Network",
    url: "https://www.thethingsnetwork.org/",
    credit: "LoRa gateways: Packet Broker / TTN",
    terms: "Courtesy credit. Daily snapshot made by tools/fetch-gateways.mjs (they ask users to cache); positions rounded to ~100 m.",
  },
  {
    id: "aisstream",
    name: "AISStream",
    url: "https://aisstream.io/",
    credit: "Ships: AISStream",
    terms: "Free, no SLA. Relayed through our Cloudflare Worker, which holds the API key; the relay keeps ships in memory for 30 min at most and stores nothing.",
  },
  {
    id: "windy",
    name: "Windy Webcams API",
    url: "https://www.windy.com/webcams/add",
    credit: "Webcams provided by windy.com – add new webcam",
    terms: "Free plan. Public webcams listed through our Cloudflare Worker, which holds the API key and caches each map tile for 10 minutes. Pictures and timelapse players come straight from Windy and load only when you click a camera. Pictures belong to the camera operators; not to be republished.",
  },
  {
    id: "youtube",
    name: "YouTube live webcams (hand-picked)",
    url: "https://www.youtube.com/",
    credit: "Live video: YouTube channels",
    terms: "A short list of public live webcams chosen by hand (no security or private cameras). The player loads only when you click a stream, from youtube-nocookie.com, muted. Each stream belongs to its channel.",
  },
];
